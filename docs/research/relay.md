# Research: relay on Cloudflare Workers + Durable Objects (Hibernation API), OAuth, local dev/test

Scope: SPEC 7.1 (relay duties, separate transfer DO), R1 (host offline within 10 s), R2 (GitHub/Google login),
R3 (relay sees only workspace id, connection id, sizes, timing; E2E byte-recording test), R7 (32 MiB message limit, 4-8 MiB chunks).

Spike: `<spike dir>/relay`
(everything below ran on this machine: macOS arm64, Node 25.4.0 and 22.22.1, no Cloudflare account).
Evidence log of the final run: `results.log` in the spike dir (`node test/run-all.mjs`, all 10 checks pass, about 90 s).
**Independently verified**: see the **Verification** section at the end.
- The suite was re-run from a fresh install in `spikes/relay-verify`, on Node 25 and 22, and against real headless Chromium.
- The recommendation holds.
- Corrections were applied in place and are marked "verifier".

---

## 1. Recommendation

### 1.1 Relay shape (Q1, Q2)

- One Worker (`apps/relay`) with two SQLite-backed Durable Object classes:
  - `WorkspaceDO`, one per workspace (`env.WORKSPACE.getByName(workspaceId)`). It carries interactive traffic and host liveness.
  - `TransferDO`, also one per workspace (`env.TRANSFER.getByName(workspaceId)`). It carries file chunks.
- Use only the Hibernation API. Call `ctx.acceptWebSocket(ws, tags)`. Never call `ws.accept()` or use `addEventListener` in a DO.
- Keep all routing state where it survives hibernation:
  - Tags: `["host"]` for the host socket. `["client", "c:<connId>"]` for each client socket, so host-to-client routing is a single `getWebSockets("c:"+id)`.
  - Attachment (`serializeAttachment`, max 16 KiB): `{role, connId | epoch, uid, since}`.
  - Tiny durable state in `ctx.storage.kv` (synchronous KV on SQLite DOs): `owner`, `hostEpoch`, `hostStatus`, `nextConn`.
  - Do not keep a `Map` of sockets in memory.
- The relay framing sits outside the E2E encryption. It is the only layer the relay understands:

  | Direction | Frame |
  |---|---|
  | client -> relay (binary) | `<ciphertext>` |
  | relay -> host (binary) | `<u32 BE connId><ciphertext>` |
  | host -> relay (binary) | `<u32 BE connId><ciphertext>` (routed, prefix stripped) |
  | relay -> client (binary) | `<ciphertext>` |
  | relay -> client (text) | `{"t":"hello","conn":N,"host":"online"\|"offline"}`, `{"t":"host.online"}`, `{"t":"host.offline","reason":"closed"\|"timeout"}` |
  | relay -> host (text) | `{"t":"peer.open","conn":N}`, `{"t":"peer.close","conn":N,"code":C}` |
  | relay -> any (text) | `{"t":"bye","code":C,"reason":R}`, sent right before any relay-initiated close |
  | host -> relay (text) | `{"t":"peer.kick","conn":N}` (the relay closes that client with 4003) |
  | both (text) | `"ping"` -> `"pong"` via `setWebSocketAutoResponse`. This never wakes the DO. |

  Close codes: 4000 host heartbeat timeout, 4001 host replaced by a newer connection, 4003 kicked, 1009 frame too big.
  Connection ids are relay-assigned u32 values (0 is reserved), persisted in `kv` so they stay unique across hibernation.
- A new host connection always replaces older host sockets. It bumps `hostEpoch`, sends `bye 4001` to the old socket and closes it. This handles "laptop woke up and reconnected while the relay still thinks the old TCP is open".
- Frame cap per relay policy: 8 MiB + 64 KiB on both DOs (8,454,144 B). This fits the largest Noise-framed app message (8 MiB becomes 8,391,060 B, see `noise.md`). It stays well under the platform's 32 MiB receive limit. The relay replies `bye 1009` if a frame is larger.
- `wrangler.jsonc` (not toml), with `$schema`, `compatibility_date: "2026-09-26"` and no extra flags.
  - `migrations: [{tag:"v1", new_sqlite_classes:["WorkspaceDO","TransferDO"]}]`.
  - `secrets.required: ["RELAY_SIGNING_KEY"]`.
  - An `env.dev` block that repeats `vars` and `durable_objects`, because those keys are not inherited.
- Pin Node **22 LTS (>= 22.12) or 24 LTS** for the monorepo (`.nvmrc` + `engines`). Wrangler needs `>= 22`. vitest 5.0.2 declares `^22.12.0 || ^24.0.0 || >=26.0.0`, so Node 25 is outside its supported range: it runs, but `npm ci` warns `EBADENGINE`. The spike passed on both 22.22.1 and 25.4.0. *(Corrected by verifier: the original text implied Node 25 is fully supported.)*

### 1.2 Host offline within 10 s, including a sleeping laptop (Q3)

- The daemon sends the text frame `"ping"` every 2 s on its WorkspaceDO socket. The runtime answers `"pong"` itself and records the time. `ctx.getWebSocketAutoResponseTimestamp(hostWs)` then returns the last ping time without waking the DO in between.
- A DO alarm acts as a deadline:
  - When a host connects or a client joins, arm the alarm at `now + 6000`.
  - In `alarm()`, compute `lastSeen = max(autoResponseTimestamp, attachment.since)`.
  - If `now - lastSeen >= 6000`: set `hostStatus = offline`, send `{"t":"host.offline","reason":"timeout"}` to every client, then send `bye 4000` to the host and close it.
  - Otherwise re-arm at `lastSeen + 6000`, but only while at least one client is connected.
- When a client joins, check liveness synchronously, so a host that froze while nobody was watching shows as offline right away.
- A clean TCP close (`webSocketClose` / `webSocketError`) sends `host.offline` (`closed`) immediately.
- Clients (browser and CLI) also send `"ping"` every 2 s and treat about 6 s without `"pong"` as "relay lost, reconnecting". This is a different UI state from "host offline".
- **The daemon needs the same pong watchdog.** If no `"pong"` arrives for 6 s, it must `terminate()` the socket and reconnect. Reacting only to `bye`/`close` is not enough. When the host's network path dies silently (Wi-Fi switch, NAT rebinding: no FIN, no RST), the relay marks the host offline after about 5 s, but its `bye`/close frames never arrive. The daemon then sits on a dead socket, and the workspace stays offline. Verified: without the watchdog the host did not come back within 25 s. With it, clients saw `host.online` again 5.2 s after the path died, once the new path was up (`test/verify-blackhole.mjs` in `relay-verify`). *(Added by verifier.)*
- **Client liveness is not covered.** The alarm only watches the host. A guest whose laptop sleeps stays in `getWebSockets("client")`, and the host never gets `peer.close`, so the R11 "online members" list would go stale. Either sweep clients in the same alarm (close any client whose `getWebSocketAutoResponseTimestamp` is older than about 30 s, which sends `peer.close`), or have the daemon run an encrypted presence heartbeat. *(Added by verifier; follows from the code, not run.)*
- Worst-case detection is about 6 s plus alarm latency. Measured locally: 6.01 s after SIGSTOP, and 5.9 s across a forced hibernation.
- Billing: the DO is hibernation-eligible between events, so it accrues no duration charge. Each alarm invocation is one billed request, and each `setAlarm()` is also one billed **row written** (pricing doc footnote). That is about 14.4k of each per day per workspace while guests are connected. Use the Workers Paid plan: the Free plan's 100k requests per day and 100k rows written per day both run out at about 7 all-day workspaces. *(Row-write part added by verifier.)*

### 1.3 E2E test harness (Q4)

- Use wrangler's `createTestHarness()`. It is the non-deprecated API: `unstable_dev` and `unstable_startWorker` are deprecated in favor of it.
  - `listen()` binds workerd on a random 127.0.0.1 port.
  - `update()` can then inject `RELAY_ISSUER = <that url>`. The port stays the same.
  - It also gives `evictDurableObject(..., {webSockets:"hibernate"})`, which forces hibernation in tests, plus `getLogs()`, `reset()` and `close()`.
  - The daemon, CLI and Playwright run as normal Node processes against `url`.
  - It works under vitest 5.0.2 and plain Node.
- R3 byte recording: a test-only tap inside the relay.
  - Set `vars.RELAY_TAP_URL = "http://127.0.0.1:<collector>/tap"`. The DOs then POST every frame they receive and send, and the Worker POSTs every request line and headers, to a collector in the test process.
  - The tap is hard-gated to local collector URLs, and the var is empty in the production config.
  - The test must assert three things: no marker in any encoding (utf8, utf16le, base64, hex); completeness (tapped frames and bytes equal what the clients sent); and a negative control (a deliberately plaintext run must be detected).
  - Do not use a raw TCP capture. Client-to-server WebSocket frames are XOR-masked, so plaintext is invisible there (verified).
  - While tap POSTs are still in flight, `evictDurableObject(..., {webSockets:"hibernate"})` fails with "Timed out waiting to evict Durable Object: it still has active references". In tests that combine the tap with forced hibernation, wait about 500 ms before evicting (verified). *(Added by verifier.)*
  - `createTestHarness` also loads the project's `.dev.vars`/`.env`, and harness `secrets` only override them (wrangler type docs). For hermetic E2E, pass every secret explicitly, and keep real OAuth secrets out of the relay package's `.dev.vars`. *(Added by verifier; doc-based.)*

### 1.4 Login (Q5)

- **Providers.**
  - GitHub OAuth App web flow: `GET https://github.com/login/oauth/authorize` with `client_id, redirect_uri, state, code_challenge, code_challenge_method=S256` and no `scope` (public identity only).
    - Then `POST https://github.com/login/oauth/access_token` with `Accept: application/json` (form body plus `code_verifier`).
    - Then `GET https://api.github.com/user` with `Authorization: Bearer` and a `User-Agent`.
    - Identity: `github:<numeric id>`.
  - Google OIDC code flow: `https://accounts.google.com/o/oauth2/v2/auth` with `response_type=code, scope=openid email profile, state, nonce, code_challenge(S256)`.
    - Then `POST https://oauth2.googleapis.com/token`.
    - Verify `id_token` with jose `createRemoteJWKSet("https://www.googleapis.com/oauth2/v3/certs")`: RS256, `iss` in {`https://accounts.google.com`, `accounts.google.com`}, `aud = client_id`, `nonce` match.
    - Identity: `google:<sub>`.
  - Provider tokens are discarded after the profile fetch. The relay stores nothing.
- **OAuth transaction state.** Store state, PKCE verifier, nonce and any CLI params in a 10-minute EdDSA-signed JWT cookie `smurg_tx` (`HttpOnly; SameSite=Lax; Path=/auth; Secure` in production). No server storage is needed.
- **Relay session.** An EdDSA JWT, 7 days, with `typ: smurg-session+jwt` and `aud: smurg-relay`.
  - Browser: an `HttpOnly; Secure; SameSite=Lax` cookie `smurg_session`. Serve the web app from the same origin, so no CORS is needed and the WebSocket upgrade carries the cookie. The relay enforces an Origin allow-list on every cookie-authenticated WebSocket upgrade.
    - Verified in headless Chromium 145 (verifier):
      - Same-origin page: cookie and Origin are sent, 101.
      - Page on another port of the same host (same-site): **the Lax cookie is still sent**, so only the Origin check stops it (403).
      - Page on `localhost` connecting to `127.0.0.1` (cross-site): no cookie is sent, 401.
    - So the Origin allow-list is the real CSWSH barrier. That covers other local dev servers and, in production, any sibling subdomain.
    - In dev, the web dev server and the relay must use the same hostname (both `localhost` or both `127.0.0.1`), or proxy the relay through Vite. Otherwise the cookie is never sent.
    - Serving the SPA from the relay Worker itself works locally:
      - Config: `assets: {directory, not_found_handling: "single-page-application", run_worker_first: ["/ws/*","/xfer/*","/auth/*","/api/*","/.well-known/*"]}`.
      - `/` and deep links return the SPA shell. API, JWKS and WebSocket routes still reach the Worker.
      - `assets` is inherited by `env.dev` (verified, `test/verify-assets.mjs`).
  - CLI and daemon: `Authorization: Bearer <token>`, stored in `~/.smurg/credentials.json` (mode 0600).
- **CLI login (loopback).**
  1. The CLI listens on `127.0.0.1:<random>`.
  2. It opens `https://<relay>/auth/<provider>/start?cli_port=P&cli_state=S&cli_code_challenge=C`.
  3. The relay runs the normal provider flow with its own registered callback. It then redirects the browser to `http://127.0.0.1:P/callback?code=<60 s JWT bound to C>&state=S`.
     - The code is **not single-use**. It is a stateless JWT: the same code and verifier were exchanged 3 times, and all 3 got 200 (verifier, `test/verify-clicode.mjs`).
     - This is acceptable because only the holder of the PKCE verifier can redeem it.
     - For true one-time use, record the `jti` in a DO (or KV) until it expires.
  4. The CLI posts `code + code_verifier` to `POST /auth/cli/token` and gets a bearer session token.
  - Only the relay's `/auth/{github,google}/callback` URLs are registered with the providers.
  - For machines without a browser, the fallback is the same code shown on a relay page for manual paste (design only, not built).
- **Secrets.**
  - `RELAY_SIGNING_KEY` (Ed25519 private JWK with `kid`), `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`.
  - Production: `wrangler secret put`. Local: `.dev.vars` (gitignored). Tests: `createTestHarness({workers:[{secrets}]})` with a key generated per run.
  - Client ids and endpoint URLs are `vars`. Tests point the endpoint URLs at a mock IdP.
- **DEV-ONLY provider.**
  - Endpoints: `GET /auth/dev/start?user=<name>` (browser or CLI loopback, same finish path) and `POST /auth/dev/token {user}` (returns a bearer token for automated tests). Identity: `dev:<name>`.
  - Enabled only when `DEV_LOGIN === "1"` (set only in `env.dev`) and the request hostname is `localhost`, `127.0.0.1`, `[::1]` or `*.localhost`.
  - Both conditions were verified: the production config returns 404 on localhost, and `env.dev` returns 404 on `relay.example.com`.

### 1.5 Identity token forwarded inside the E2E channel (Q6)

- `POST /api/identity-token {workspaceId, cnf}` requires a session. It returns an EdDSA JWT with `typ: smurg-identity+jwt`, `iss: <relay origin>`, `aud: smurg-daemon:<workspaceId>`, a 5-minute lifetime, `jti`, `sub/name/provider`, and optionally `cnf: {"smurg-noise-static": <commitment>}`.
- **Do not send the raw device static key fingerprint to the relay** *(corrected by verifier)*.
  - `noise.md` rejected KK precisely because a cleartext device identifier leaks a stable id to the relay (R3). The original `cnf` design hands the relay that exact identifier, bound to the account and workspace.
  - Instead, send a blinded commitment: `cnf = base64url(SHA-256("smurg-cnf" || n || device_static_pub))`, with a fresh random 32-byte `n`.
  - The client puts `n` inside the encrypted msg3 payload next to the token. The daemon recomputes the commitment from `n` and the Noise remote static key.
  - The relay then only sees a random-looking value. (Design correction; the hash is trivial and was not separately run.)
- The public key is served at `GET /.well-known/jwks.json` (`kid` = RFC 7638 thumbprint; add keys there to rotate).
- The daemon verifies with `jose.createRemoteJWKSet(<relay>/.well-known/jwks.json)` and `jwtVerify(token, jwks, {issuer, audience, typ, algorithms:["EdDSA"], maxTokenAge:"5m"})`. It must also check that `cnf` matches the Noise remote static key of that connection, via the commitment above. At first contact, treat a missing `cnf` as a failure.
- Send it in the Noise msg3 payload at first contact (see `noise.md`). It is advisory identity from the relay; the device key plus the invite PSK remain the real proof.

### 1.6 Transfers and backpressure (Q7)

- Routes: `wss://<relay>/xfer/<workspaceId>/(host|client)` go to `env.TRANSFER.getByName(workspaceId)`, with the same framing and code (`class TransferDO extends RelayRoom`, no alarm).
  - The Worker checks that a `host` on `/xfer` is the workspace owner, via RPC to the WorkspaceDO.
  - The daemon keeps a second, lazily opened socket to it. It hibernates for free when idle.
  - Each transfer socket gets its own Noise session (`noise.md` gotcha 6).
- Do not send file bytes on the WorkspaceDO socket. Measured with a 5 MB/s emulated host downlink: interactive RTT p50 was **5.0 ms** with bulk on TransferDO, versus **1762 ms** with the same bulk on the WorkspaceDO socket (head-of-line blocking). The verifier reproduced 5.0 vs 1761 ms on Node 25 and 4.8 vs 1778 ms on Node 22.
  - **Caveat on the magnitude** *(added by verifier)*. `test/throttle-proxy.mjs` serves each TCP connection from its own queue, round-robin. That is fair queuing, like a router running fq_codel.
  - A typical home router or ISP link is one FIFO. There, typing latency during an upload still rises by the bottleneck's queue delay, often tens to hundreds of ms.
  - The separate socket removes the multi-second relay and TCP-stream head-of-line component, which is the part the relay controls. It cannot remove link bufferbloat.
  - So cap the daemon's credit window at the smaller of 8 MiB (below) and about 1 s of measured throughput.
- **Two sockets have no ordering between them.** The protocol must not assume that a `file.*` control message on the WorkspaceDO socket arrives before or after chunks on the TransferDO socket. Put begin, commit and ack for an upload on the transfer channel itself, or sequence them explicitly. *(Added by verifier.)*
- **Backpressure must be end to end.** WebSockets inside a DO have no `bufferedAmount` (verified `undefined`) and no send callback, so the relay buffers whatever the uploader pushes.
  - Locally, 192 MiB pushed at a stalled host grew workerd RSS by about 100-170 MiB (verifier: 196 -> 374 MiB and 269 -> 439 MiB).
  - **Correction** *(verifier)*: 128 MB is the limit **per isolate**, not per DO. The DO pricing doc (footnote 5) says Durable Objects of one class "may run in the same isolate on the same physical machine and share the 128 MB of memory".
    - Several workspaces' TransferDOs, each with 16 MiB in flight plus a transient copy of the frame being prefixed, could together reset that isolate. That would drop every socket of every co-located DO.
    - The original "a production DO has 128 MB" was wrong. Whether bytes queued in a hibernatable socket's outbound buffer count toward the isolate limit is **unverified**.
  - Use a daemon-granted credit window: chunk 4 MiB, at most **8 MiB** (2 chunks) un-acked in flight per workspace in total. The daemon splits credits across concurrent uploads.
    - 8 MiB at 200 ms RTT still allows about 40 MiB/s, far above home uplinks. *(Lowered from 16 MiB by verifier because of the shared-isolate limit.)*
    - Zero-copy option: the client sends 4 reserved zero bytes in front of the ciphertext, and the relay writes the connId into them in place. This avoids the 4 + N copy in `webSocketMessage` (idea only, not run).
  - Acks and credits travel encrypted on the transfer channel.
  - The browser also checks its own `ws.bufferedAmount` before reading the next slice of `File.stream()`. Verified in Chromium 145:
    - After 4 x 4 MiB `send()` calls, `bufferedAmount` read 16,777,216 and drained to 0 in 77 ms locally, so it is a usable signal.
    - Set `ws.binaryType = "arraybuffer"`; browsers default to Blob.
  - The relay frame cap has to be derived from the protocol package's constants (max app message plus Noise overhead from `noise.md`), not hard-coded separately.
    - Never base64 file bytes inside a JSON Envelope: an 8 MiB chunk would become about 11.2 MB and hit the 8 MiB + 64 KiB cap.
  - Downloads use the same scheme with the browser granting credits.
  - The relay only enforces the frame cap.

---

## 2. Dependencies (exact versions installed in the spike)

| Package | Version | Used by | Note |
|---|---|---|---|
| `wrangler` | 4.142.0 | apps/relay (dev), E2E tests (`createTestHarness`) | bundles `workerd` 1.20260926.1 and `miniflare` 5.20260926.0-alpha; `engines.node >= 22` |
| `jose` | 6.2.12 | apps/relay (sign/verify, remote JWKS), packages/daemon (verify identity tokens) | `EdDSA` and `Ed25519` alg names both supported; Web Crypto based, same build runs in workerd and Node |
| `ws` | 8.22.0 | packages/daemon, packages/cli, tests | Node WebSocket client with custom headers (bearer auth) |
| `vitest` | 5.0.2 | E2E test runner (Node pool) | `createTestHarness` verified under it on Node 22.22.1 and 25.4.0. `engines.node` is `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`, so Node 25 is unsupported (EBADENGINE warning) |
| `typescript` | 7.0.2 | typecheck | `tsc -p .` passes against `wrangler types` output |
| `@cloudflare/workers-types` | 5.20260927.1 | not needed | installed but superseded: use `wrangler types` (generates `worker-configuration.d.ts` matching the bundled workerd) |
| Node | 22.22.1 and 25.4.0 | all | both verified (harness and `wrangler dev`). Pin 22 LTS (>= 22.12) or 24 LTS for the monorepo because of vitest's engines range |

`@cloudflare/vitest-pool-workers` 0.22.0 exists and was not used. It runs tests inside workerd, which fits unit tests of the relay but not cross-process E2E with the daemon.
- The verifier confirmed via `npm view` that it has peer `vitest ^4.1.0` and pins `wrangler 4.124.0` and `miniflare 5.20260815.0-alpha`.
- So it **cannot** be combined with vitest 5 or wrangler 4.142. Use `createTestHarness` under vitest 5 for all relay tests.

---

## 3. Verified facts

| # | Claim | Evidence |
|---|---|---|
| V1 | Hibernation API surface in the installed runtime: `acceptWebSocket(ws, tags?)`, `getWebSockets(tag?)`, `getTags`, `setWebSocketAutoResponse(new WebSocketRequestResponsePair(req,res))`, `getWebSocketAutoResponse`, `getWebSocketAutoResponseTimestamp(ws)`, `setHibernatableWebSocketEventTimeout`, `ws.serializeAttachment/deserializeAttachment`, handlers `webSocketMessage(ws, string\|ArrayBuffer)`, `webSocketClose(ws, code, reason, wasClean)`, `webSocketError(ws, err)`, `alarm()`, `ctx.storage.kv` (sync KV), `getByName()` | `node_modules/@cloudflare/workers-types/index.d.ts` lines 620-711, 3799-3800; `worker-configuration.d.ts` from `wrangler types`; `tsc -p .` exit 0; used by the running spike |
| V2 | Doc limits: 32,768 hibernatable sockets per DO; at most 10 tags of at most 256 chars each; attachment at most 16,384 B; auto-response request and response at most 2,048 chars; DO idle hibernation after about 10 s; alarms at-least-once with retries | Cloudflare docs fetched as markdown (`docs-cache/durable-objects_api_state.md`, `do-websockets.md`, `..._lifecycle.md`, `..._alarms.md`) |
| V3 | WebSocket received-message limit is 32 MiB. Locally it is enforced exactly: a 33,554,432 B frame is delivered, and a 33,554,433 B frame closes the socket with `1009 Message is too large: 33554433 > 33554432` | `test/limits.mjs` part A (relay cap raised via `TRANSFER_MAX_FRAME`); DO limits doc: "WebSocket message size 32 MiB (only for received messages)" |
| V4 | Pairing works under `createTestHarness` **and** `wrangler dev` (local, no account) on Node 25.4.0 and 22.22.1: conn ids 1..N; client->host frames arrive with the conn prefix and intact; host->client frames are routed by prefix with it stripped and no cross-delivery; `peer.open`/`peer.close`/`host.online`/`host.offline`; early joiner gets `hello host:offline` then `host.online`; non-owner host gets 403, anonymous gets 401; kick closes the client with 4003; reconnecting host gets a `peer.open` replay; a newer host replaces the older one (4001) | `test/pairing.mjs`, `test/wrangler-dev.mjs` (`wrangler dev ready ... after 647 ms (node v25.4.0)`; same with v22.22.1) |
| V5 | State survives hibernation: after `evictDurableObject(..., {webSockets:"hibernate"})` sockets stay open, the constructor re-runs (`bootedAt` changes), tags, attachments and kv are restored, and routing works both ways | `test/hibernation.mjs` |
| V6 | An auto-response ping does **not** wake a hibernated DO, and `getWebSocketAutoResponseTimestamp` still reports the ping after wake-up (`lastSeenAgo: 121 ms`). Verifier: the original assertion `bootedAt > tPing` would also pass if the ping *had* woken the DO, so it proved nothing. A strict re-test sent pings while the DO was hibernated, then read `bootedAt` 300 ms later. The DO was constructed 3-10 ms **after** the debug call started, so the pings did not construct it. A positive control (a binary frame) woke it 300 ms earlier. Pings are also never delivered to `webSocketMessage` while the DO is awake: 10 pings, 0 tapped | `test/hibernation.mjs`; strict version `relay-verify/test/verify-extra.mjs` |
| V7 | Local workerd hibernates idle DOs by itself (about 10 s; auto-responded pings do not keep it awake): `bootedAt` changed after 25 s idle | `test/auto-hibernate.mjs` |
| V8 | Host frozen with SIGSTOP (TCP left open): all clients get `host.offline(timeout)` after **6012 ms**; no false offline during 10 s of healthy pinging; a late joiner gets `hello host:offline`; after SIGCONT the host reads the queued `bye 4000` within 2 ms, reconnects, and clients get `host.online` 256 ms after wake-up; with no clients the alarm is not re-armed (`alarm: null`) and liveness is checked lazily when someone joins | `test/heartbeat.mjs`, `results.log` |
| V9 | Offline detection also works when the DO is hibernated at the moment the host stops pinging: **5906 ms** (the alarm wakes the DO) | `test/hibernation.mjs` |
| V10 | Local workerd does **not** auto-reply to a client-initiated close for hibernatable sockets (with compat date 2026-09-26): without `ws.close()` in `webSocketClose`, the TCP connection lingered about 16 s and the client saw 1006. With it, the close completes in 3-8 ms with 1000 | `test/close-exp2.mjs` (before and after the fix) |
| V11 | After a server-initiated `ws.close()` the close frame arrives in 0-3 ms, but local workerd's TCP FIN comes 10-16 s later. **Node clients** fire `close` only then: `ws`, and also Node's built-in WHATWG `WebSocket` (undici), which the verifier measured at 15.9-16.0 s. **Chromium 145 does not wait**: the relay's kick produced `bye` at +10 ms and the browser `close` event at +13 ms (code 4003, `wasClean: true`). Sending `{"t":"bye"}` first and having Node clients terminate on it gives 1-2 ms. *(Corrected by verifier: the original also claimed browsers wait for the FIN.)* | `test/close-exp2.mjs`; `relay-verify/test/verify-close.mjs`; browser run via `verify-browser-host.mjs` + `/__test/browser.html` |
| V12 | A DO-side WebSocket has no `bufferedAmount` (`typeof` is `undefined`). With no flow control, 192 MiB pushed at a SIGSTOPped host is buffered by the relay: workerd RSS went 278 -> 439 MiB, and everything was delivered after SIGCONT | `test/limits.mjs` part C |
| V13 | Throughput through TransferDO locally: 8 MiB frames with window 4 gave 381-417 MiB/s; 1 MiB frames with window 8 gave about 400 MiB/s | `test/limits.mjs`, `test/isolation.mjs` |
| V14 | Separate transfer socket vs same socket, host downlink emulated at 5 MB/s: interactive RTT p50 **5.0 ms** (bulk on TransferDO) vs **1762 ms** (bulk on WorkspaceDO). Without the bandwidth limit, local workerd shows no difference (about 14 ms p50 for both), because all DOs share one local process. Verifier: the emulator queues each connection separately, which is fair queuing, so 5.0 ms is a best case. On a single-FIFO home link, expect added bufferbloat delay (see §1.6) | `THROTTLE=5000000 node test/isolation.mjs`, `test/throttle-proxy.mjs` |
| V15 | The test-only tap (DO -> `fetch` to a 127.0.0.1 collector) captures every frame: 40/40 frames, and tapped bytes = sent bytes + 4 B prefix per host frame. The plaintext run finds the marker (`hits:["utf8"]`); the encrypted run finds none (`hits:[]`) | `test/tap.mjs` |
| V16 | A raw TCP capture cannot validate R3: the marker was not visible in client->server bytes (masked) but was visible in server->client bytes | `test/raw-capture-pitfall.mjs` |
| V17 | jose EdDSA works in workerd: key import from JWK, JWKS served (`OKP Ed25519 EdDSA`), session tokens signed and verified in the Worker. Node verifies a relay-minted identity token via `createRemoteJWKSet`. Negatives: another workspace's `aud` or a session token used as identity gives `ERR_JWT_CLAIM_VALIDATION_FAILED`; a tampered payload or a token forged with another Ed25519 key under the same `kid` gives `ERR_JWS_SIGNATURE_VERIFICATION_FAILED`. Node-side EdDSA sign/verify also works | `test/smoke.mjs`, `test/auth.mjs` |
| V18 | `createRemoteJWKSet` plus RS256 `id_token` verification works inside workerd (Google flow against the mock IdP, `sub google:110248495921238986420`) | `test/auth.mjs` + `test/mock-idp.mjs` |
| V19 | The GitHub-style web flow runs end to end in workerd against a mock enforcing state echo, PKCE S256, client secret, `redirect_uri` match and User-Agent: session `github:12345`. A wrong `state` gives 400 | `test/auth.mjs` |
| V20 | CLI loopback login works for the dev provider and the GitHub flow. A wrong PKCE verifier gets 400 | `test/auth.mjs` (`CLI loopback login via github -> github:12345`) |
| V21 | WebSocket auth: cookie with allowed Origin gets 101; cookie with a foreign Origin, or with no Origin, gets 403; bearer without Origin (CLI/daemon) gets 101; no credentials get 401. Verifier: `auth.mjs` only *logs* these results (and the wrong-state and JWT negatives) without asserting them. The logged values were correct on re-run. The same checks also held in real Chromium (see §1.4) | `test/auth.mjs` |
| V22 | Dev-only features are off in the production config: `POST /auth/dev/token` on localhost and `/__debug` both 404. In `env.dev`, dev login on a non-local hostname gets 404 | `test/gating.mjs`, `test/auth.mjs` |
| V23 | `createTestHarness` binds a random port (56075, 57975, 58586, ... in different runs). `update()` after `listen()` kept the same URL, so `RELAY_ISSUER` can equal the listen URL. It works under vitest 5.0.2 | `test/lib.mjs startRelay`, `npx vitest run e2e/` (1 passed) |
| V24 | `unstable_startWorker` still works (deprecated) and passes the same pairing test | `test/startworker-alt.mjs` |
| V25 | GitHub supports PKCE (S256 only) in the web flow and loopback redirect URLs; the token endpoint returns form encoding unless `Accept: application/json`; the REST API rejects requests without `User-Agent` | GitHub docs fetched (`docs-cache/github-authorizing-oauth-apps.md`, `github-rest-user-agent.md`) |
| V26 | Google discovery (live): issuer `https://accounts.google.com`, auth `.../o/oauth2/v2/auth`, token `https://oauth2.googleapis.com/token`, JWKS `https://www.googleapis.com/oauth2/v3/certs`, `code_challenge_methods_supported: [plain, S256]`, id_token alg RS256 | `docs-cache/google-openid-configuration.json` |
| V27 | Production build is small: `wrangler deploy --dry-run` gives 74.74 KiB / 19.63 KiB gzip with jose included | `npx wrangler deploy --dry-run --outdir .dist` |
| V28 | Compat date 2026-09-26 turns on by default: `web_socket_auto_reply_to_close` (2026-04-07), `websocket_standard_binary_type` (2026-03-17; DO `webSocketMessage` still gets `ArrayBuffer`), `websocket_close_reason_byte_limit` (2026-03-03; `close()` throws if the reason exceeds 123 B), `nodejs_compat` (2026-08-04) | compat-flags doc; `wrangler types` printed the nodejs_compat notice |
| V29 | A WebSocket *protocol* ping from the host gets a pong but does not move `getWebSocketAutoResponseTimestamp`; a text `"ping"` does | `test/protocol-ping.mjs`: `pong frames received=1; lastSeen moved: false` / `text "ping": lastSeen moved: true` |

---

## 4. Unverified / could not test here

- **Anything on real Cloudflare** (no account, by rule):
  - production hibernation and eviction timing, and alarm firing latency;
  - whether the close-handshake quirks (V10/V11) also exist in production;
  - what happens when an isolate exceeds 128 MB (expected: reset, dropping the sockets of every co-located DO; see §1.6);
  - whether WorkspaceDO and TransferDO of one workspace land on different threads or machines;
  - real WAN latency and throughput;
  - `wrangler secret put` and `wrangler deploy`.
- **Real GitHub and Google OAuth apps.** Only a mock IdP that mirrors the documented parameters was used. Consent screens and the exact error bodies from the real providers were not seen.
- **Real browsers.** The "browser" in `auth.mjs` is `fetch` with a cookie jar.
  - The verifier has since checked headless Chromium 145: cookie + Origin handling, SameSite=Lax behavior, relay-initiated and client-initiated close timing, `bufferedAmount`, and text ping/pong.
  - Serving the SPA from the same Worker was checked locally.
  - Still unverified: Firefox and Safari, `Secure` cookies on `http://localhost`, and background-tab timer throttling of the client ping loop. After 5 minutes hidden, Chrome's intensive throttling can delay timers to about once a minute, so the client "relay lost" check must not count missed ticks as lost pongs.
- **The manual-paste or device-code CLI fallback.** Design only.
- **Cost figures** (alarm counts vs Free/Paid plan limits, 20:1 message billing) come from the pricing doc and arithmetic, not from a bill.
- `@cloudflare/vitest-pool-workers` was not run. Its npm metadata shows it is incompatible with vitest 5 and wrangler 4.142 (see §2).
- The absolute throughput and RTT numbers are local (loopback, one laptop). Only the relative head-of-line result (V14) is meaningful.

---

## 5. Gotchas

1. **Always call `ws.close()` in `webSocketClose`** even with compat date >= 2026-04-07. Locally, hibernatable sockets are not auto-replied (V10).
2. **Relay-initiated closes: send `{"t":"bye",code,reason}` first.** Clients (daemon, CLI, web) treat it as closed now and `terminate()`. The TCP FIN can lag 10-16 s locally (V11), and Node clients only fire `close` then. That covers both `ws` and Node's built-in `WebSocket`. Chromium fires `close` in about 13 ms, but the web client should still honor `bye` for uniformity. (Verifier corrected "browsers".)
3. **No backpressure inside a DO** (V12). Never let an uploader free-run. Use credit windows end to end, a relay frame cap, and 4 MiB chunks.
4. **Local dev hibernates for real** (V7). Anything kept only in memory (maps, counters, timers) disappears after about 10 s idle. Use tags, attachments and `ctx.storage.kv`. Keep the constructor cheap: it runs on every wake-up, and `setWebSocketAutoResponse` belongs there.
5. **`setTimeout`/`setInterval` in a DO prevent hibernation.** Use alarms. There is one alarm per DO, so multiplex deadlines if more are added later.
6. **Heartbeats must be the exact auto-response string**, as text frames. Protocol-level pings (opcode 0x9) are auto-ponged but do **not** update `getWebSocketAutoResponseTimestamp` (V29). Browsers cannot send protocol pings at all.
7. **Keep the heartbeat on a socket that never carries bulk data.** A ping queued behind 1 MiB frames on a 5 MB/s link waits about 1.7 s (V14).
8. **Stale host sockets.** After a laptop sleeps, the relay may still hold the old socket as OPEN. Always let the newest host connection win (epoch in the attachment, `bye 4001` to older ones), and ignore close events from non-current epochs.
9. **Deploys disconnect every WebSocket.** Daemon, web and CLI need reconnect with jittered backoff. Show "relay reconnecting" as a different state from "host offline".
10. **The conn id is relay-assigned and not authenticated.** The daemon keys each Noise session by conn id and treats any decrypt failure as fatal for that conn. A relay that mixes up ids only causes failures, never cross-talk.
11. **R3 metadata nuance.** Because the relay does OAuth (R2), it also knows which authenticated account and which IP address opens which connection. That is more than "workspace id, connection id, sizes, timing". The spec should say so explicitly.
12. **Raw packet capture is not a valid R3 test** (masking, V16). Tap at the relay code level, check completeness, and include a positive control. Markers must be at least 16 bytes (`noise.md` gotcha 18).
13. **Close reasons must be at most 123 bytes UTF-8**, or `close()` throws (compat >= 2026-03-03).
14. **The compat date turns on `nodejs_compat` from 2026-08-04.** Harmless here (bundle 74.7 KiB), but `wrangler types` will suggest `@types/node`.
15. **Wrangler config.**
    - `env.<name>` blocks do not inherit `vars` or `durable_objects`; repeat them.
    - With several envs, deploy production with `--env=""` (wrangler warns otherwise).
    - `migrations` must use `new_sqlite_classes`: the Free plan only allows SQLite-backed DOs, and they give you `storage.kv` and `storage.sql`.
16. **Wrangler writes global state** (metrics consent, logs, a skills cache) to `~/Library/Preferences/.wrangler` on macOS. Set `XDG_CONFIG_HOME=<repo>/.xdg` and `WRANGLER_SEND_METRICS=false` in test/CI scripts. The spike's first two wrangler invocations created that directory on this machine before this was set (see "How to re-run").
17. **Browsers cannot set `Authorization` on a WebSocket.** That forces cookie auth for web, which in turn requires the Origin allow-list (CSWSH). Node `ws` sends no Origin by default, so bearer auth skips that check.
18. **GitHub.** Missing `User-Agent` means a 403. The token endpoint needs `Accept: application/json`. PKCE is S256 only. The authorize page has no CORS: always use a top-level redirect.
19. **Google.** Accept both issuer spellings. Check `nonce`. Use `email` only if `email_verified`.
20. **Billing.**
    - Alarms are billed 1:1 as requests; incoming WebSocket messages 20:1; auto-responses and protocol pings are free.
    - Batch PTY output (for example 16-33 ms) before encrypting, so a busy terminal does not become thousands of DO messages per minute.
21. **`createTestHarness` + `RELAY_ISSUER`.** The issuer must equal the URL the tests use, because the OAuth `redirect_uri` is built from it. Call `listen()`, then `update()` with the URL, then `listen()` again (V23).
22. **Local isolation checks lie.** All DOs share one workerd process locally, so "TransferDO keeps typing smooth" only shows up with a bandwidth-limited host link (V14).
23. **(Verifier) The daemon needs a pong watchdog** as well as `bye` handling (§1.2). Verified: without it, a silently dead path keeps the workspace offline indefinitely.
24. **(Verifier) Any logged-in account can open client sockets to any workspace id it knows.** The id travels in the invite path, not the fragment. Access control is the daemon's Noise handshake, which is correct. The relay should still cap client sockets per workspace and per account and rate-limit upgrades, and `noise.md` recommends handshake deadlines. Relay session JWTs are stateless for 7 days and cannot be revoked. Kicks are enforced by the daemon (device key revocation plus `peer.kick`), not by the relay.
25. **(Verifier) The top-level config must carry production values.** The spike's top-level vars are `RELAY_ISSUER=http://localhost:8787` and `ALLOWED_ORIGINS=http://localhost:5173`, and `wrangler deploy --dry-run` shows those going to production. Put the real origin there and keep localhost values in `env.dev`.
26. **(Verifier) Identity-token `cnf` must be blinded** (§1.5). Otherwise the relay learns a stable device key id per account.

---

## 6. Verified code (key snippets that ran)

### 6.1 `wrangler.jsonc` (trimmed)

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "smurg-relay-spike",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-26",
  "durable_objects": { "bindings": [
    { "name": "WORKSPACE", "class_name": "WorkspaceDO" },
    { "name": "TRANSFER",  "class_name": "TransferDO" } ] },
  "migrations": [ { "tag": "v1", "new_sqlite_classes": ["WorkspaceDO", "TransferDO"] } ],
  "secrets": { "required": ["RELAY_SIGNING_KEY"] },
  "vars": { "RELAY_ISSUER": "http://localhost:8787", "DEV_LOGIN": "0", "RELAY_TAP_URL": "",
            "ALLOWED_ORIGINS": "http://localhost:5173", "HOST_TIMEOUT_MS": "6000",
            "GITHUB_CLIENT_ID": "", "GOOGLE_CLIENT_ID": "", "GITHUB_AUTHORIZE_URL": "https://github.com/login/oauth/authorize" /* ...other endpoints... */ },
  "env": { "dev": { "vars": { "DEV_LOGIN": "1" /* ...all other vars repeated... */ },
                    "durable_objects": { "bindings": [ /* repeated */ ] },
                    "secrets": { "required": ["RELAY_SIGNING_KEY"] } } }
}
```

### 6.2 Durable Object core (`src/room.ts`, shared by `WorkspaceDO` and `TransferDO`)

```ts
abstract class RelayRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.kv = ctx.storage.kv;
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong")); // never wakes the DO
  }

  async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).searchParams.get("role");
    const uid = req.headers.get("x-smurg-uid") ?? "";           // set by the Worker after auth
    const { 0: client, 1: server } = new WebSocketPair();
    const now = Date.now();
    if (role === "host") {
      if (this.requiresOwner() && this.kv.get("owner") !== uid) return new Response("not the workspace owner", { status: 403 });
      const epoch = (this.kv.get<number>("hostEpoch") ?? 0) + 1;
      this.kv.put("hostEpoch", epoch);
      for (const old of this.ctx.getWebSockets("host")) this.closeWithBye(old, 4001, "replaced by newer host connection", "host", 0);
      this.ctx.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({ role: "host", epoch, uid, since: now });
      this.kv.put("hostStatus", "online");
      for (const c of this.ctx.getWebSockets("client")) {
        const a = c.deserializeAttachment();
        this.sendText(server, { t: "peer.open", conn: a.conn }, "host", 0);
        this.sendText(c, { t: "host.online" }, "client", a.conn);
      }
      await this.armAlarm(now);
    } else if (role === "client") {
      const conn = this.allocConn();                                // u32 counter in ctx.storage.kv
      this.ctx.acceptWebSocket(server, ["client", `c:${conn}`]);
      server.serializeAttachment({ role: "client", conn, uid, since: now });
      const host = this.liveHostOrMarkOffline();                    // lazy liveness check on join
      this.sendText(server, { t: "hello", conn, host: host ? "online" : "offline" }, "client", conn);
      if (host) { this.sendText(host, { t: "peer.open", conn }, "host", 0); await this.armAlarm(now); }
    } else return new Response("bad role", { status: 400 });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    const att = ws.deserializeAttachment();
    if (typeof msg === "string") { if (att.role === "host") this.onHostControl(msg); return; } // peer.kick
    if (msg.byteLength > this.maxFrame) { this.closeWithBye(ws, 1009, "frame too large for this channel", att.role, 0); return; }
    if (att.role === "client") {
      const host = this.currentHost();
      if (!host) { this.sendText(ws, { t: "host.offline", reason: "closed" }, "client", att.conn); return; }
      const out = new Uint8Array(4 + msg.byteLength);
      new DataView(out.buffer).setUint32(0, att.conn);
      out.set(new Uint8Array(msg), 4);
      host.send(out);
    } else {
      if (msg.byteLength < 4) return;
      const conn = new DataView(msg).getUint32(0);
      const target = this.ctx.getWebSockets(`c:${conn}`)[0];
      if (!target) { this.sendText(ws, { t: "peer.close", conn, code: 0 }, "host", 0); return; }
      target.send(new Uint8Array(msg, 4));
    }
  }

  async webSocketClose(ws: WebSocket, code: number) {
    this.onGone(ws, code); // client: peer.close to host; current host: host.offline(closed) to clients
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch {} // see gotcha 1
  }

  async alarm() {
    if (!this.watchHost) return;                          // TransferDO: no alarm
    const host = this.currentHost(); if (!host) return;
    const last = this.hostLastSeen(host), timeout = this.timeoutMs();
    if (Date.now() - last >= timeout) { this.markHostOffline(host, "timeout"); return; }
    if (this.ctx.getWebSockets("client").length > 0) await this.ctx.storage.setAlarm(last + timeout + 25);
  }

  protected hostLastSeen(host: WebSocket) {
    const ping = this.ctx.getWebSocketAutoResponseTimestamp(host)?.getTime() ?? 0;
    return Math.max(ping, host.deserializeAttachment().since);
  }

  private closeWithBye(ws: WebSocket, code: number, reason: string, role: string, conn: number) {
    this.sendText(ws, { t: "bye", code, reason }, role, conn);
    try { ws.close(code, reason); } catch {}
  }
}
export class WorkspaceDO extends RelayRoom { protected readonly maxFrame = MAX_FRAME; protected readonly watchHost = true; }
export class TransferDO extends RelayRoom { /* maxFrame = MAX_FRAME, watchHost = false, owner checked in Worker */ }
```

### 6.3 Worker routing and WebSocket auth (`src/index.ts`)

```ts
m = path.match(/^\/(ws|xfer)\/([A-Za-z0-9_-]{16,64})\/(host|client)$/);
if (m) {
  if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("upgrade required", { status: 426 });
  if (!s) return new Response("unauthorized", { status: 401 });            // s = session from cookie or bearer
  if (s.via === "cookie") {                                                // browser => Origin allow-list
    const origin = req.headers.get("origin") ?? "";
    if (!env.ALLOWED_ORIGINS.split(",").map((x) => x.trim()).includes(origin)) return new Response("bad origin", { status: 403 });
  }
  const [, kind, workspaceId, role] = m;
  if (kind === "xfer" && role === "host") {
    const st = await env.WORKSPACE.getByName(workspaceId).debugState();     // real code: a getOwner() RPC
    if (st.owner !== s.claims.sub) return new Response("not the workspace owner", { status: 403 });
  }
  const fwd = new URL(req.url); fwd.search = `?role=${role}`;
  const headers = new Headers(req.headers);
  headers.set("x-smurg-uid", s.claims.sub!); headers.delete("cookie"); headers.delete("authorization");
  return (kind === "ws" ? env.WORKSPACE : env.TRANSFER).getByName(workspaceId).fetch(new Request(fwd, { headers }));
}
```

### 6.4 Tokens with jose in workerd (`src/auth.ts`)

```ts
const jwk = JSON.parse(env.RELAY_SIGNING_KEY);                 // Ed25519 private JWK (secret)
const { d, ...publicJwk } = jwk;
const kid = jwk.kid ?? (await calculateJwkThumbprint(publicJwk));
const priv = await importJWK(jwk, "EdDSA");
const pub = await importJWK(publicJwk, "EdDSA");
// GET /.well-known/jwks.json -> { keys: [{ ...publicJwk, kid, alg: "EdDSA", use: "sig" }] }

const sign = (typ: string, aud: string, ttlSec: number, claims: JWTPayload) =>
  new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", kid, typ })
    .setIssuer(env.RELAY_ISSUER).setAudience(aud).setIssuedAt().setExpirationTime(`${ttlSec}s`)
    .setJti(crypto.randomUUID()).sign(priv);

export const issueSession  = (env, id) => sign("smurg-session+jwt", "smurg-relay", 7 * 24 * 3600, { sub: id.sub, name: id.name, provider: id.provider });
export const issueIdentity = (env, session, workspaceId, cnf?) =>
  sign("smurg-identity+jwt", `smurg-daemon:${workspaceId}`, 300,
       { sub: session.sub, name: session.name, provider: session.provider, ...(cnf ? { cnf: { "smurg-noise-static": cnf } } : {}) });
// verify: jwtVerify(token, pub, { issuer, audience, typ, algorithms: ["EdDSA"] })

// CLI: short-lived (not single-use) loopback code bound to the CLI's PKCE challenge, exchanged at POST /auth/cli/token
const code = await sign("smurg-cli-code+jwt", "smurg-cli-code", 60, { sub, name, provider, cc: cli.cc });
// ... 302 -> http://127.0.0.1:${cli.port}/callback?code=...&state=...
if ((await s256(body.code_verifier)) !== payload.cc) return new Response("pkce mismatch", { status: 400 });
```

### 6.5 Daemon side: verify the identity token (Node, `test/auth.mjs`)

```js
import { createRemoteJWKSet, jwtVerify } from "jose";
const JWKS = createRemoteJWKSet(new URL(`${relayOrigin}/.well-known/jwks.json`));
const { payload } = await jwtVerify(idTok, JWKS, {
  issuer: relayOrigin, audience: `smurg-daemon:${workspaceId}`,
  typ: "smurg-identity+jwt", algorithms: ["EdDSA"], maxTokenAge: "5m",
});
// then: payload.cnf["smurg-noise-static"] === fingerprint(noise remote static key of this conn)
```

### 6.6 Daemon heartbeat and reconnect (`test/host-proc.mjs`)

```js
const ws = new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, perMessageDeflate: false });
ws.on("open", () => { pinger = setInterval(() => ws.readyState === 1 && ws.send("ping"), 2000); });
ws.on("message", (d, bin) => {
  if (bin) return /* <u32 conn><ciphertext> */;
  const s = d.toString(); if (s === "pong") { lastPong = Date.now(); return; }
  const m = JSON.parse(s);
  if (m.t === "bye") reconnect(`bye ${m.code}`);   // do not wait for the TCP close
});
// VERIFIER ADDITION (required): pong watchdog. Without it, a silently dead network path
// (no FIN/RST) leaves the daemon on a dead socket forever. Verified in relay-verify/test/verify-blackhole.mjs.
watchdog = setInterval(() => { if (Date.now() - lastPong > 6000) reconnect("pong watchdog"); }, 500);
```

### 6.7 E2E harness (recommended), with byte tap (`test/lib.mjs`, `test/tap.mjs`, `e2e/relay.e2e.test.mjs`)

```js
import { createTestHarness } from "wrangler";

export async function startRelay({ vars = {}, secrets = {} } = {}) {
  process.env.XDG_CONFIG_HOME ??= path.join(ROOT, ".xdg");     // keep wrangler out of ~/Library/Preferences
  process.env.WRANGLER_SEND_METRICS = "false";
  const key = secrets.RELAY_SIGNING_KEY ?? (await ephemeralSigningKey()); // jose generateKeyPair("EdDSA") -> JWK
  const server = createTestHarness({
    root: ROOT,
    workers: [{ configPath: "./wrangler.jsonc", env: "dev", vars, secrets: { RELAY_SIGNING_KEY: key, ...secrets } }],
  });
  const { url } = await server.listen();                        // random 127.0.0.1 port
  const base = url.toString().replace(/\/$/, "");
  if (!vars.RELAY_ISSUER) await server.update((cur) => ({ ...cur,
    workers: cur.workers.map((w) => ({ ...w, vars: { ...(w.vars ?? {}), RELAY_ISSUER: base } })) }));
  const { url: url2 } = await server.listen();                  // same URL after update (verified)
  const b = url2.toString().replace(/\/$/, "");
  return { server, base: b, wsBase: b.replace(/^http/, "ws"), worker: server.getWorker() };
}

// vitest
let relay, tap;
beforeAll(async () => {
  tap = await startTapCollector();                              // node:http server, stores every POST body + x-tap-* headers
  relay = await startRelay({ vars: { RELAY_TAP_URL: tap.url } });
}, 60_000);
afterAll(async () => { await relay?.server.close(); await tap?.close(); });
test("relay never sees plaintext", async () => {
  // ... drive daemon + clients through relay.wsBase with real E2E encryption ...
  expect(findPlaintext(tap.all(), MARKER)).toEqual([]);         // utf8 / utf16le / base64 / hex
  // plus: completeness (tapped frames == sent frames) and a plaintext positive-control run
});
// VERIFIER NOTE: the spike's e2e/relay.e2e.test.mjs is vacuous as an R3 test. It searches for
// "SMURG-PLAINTEXT-MARKER" but never sends it. The real R3 test must put the marker into the
// plaintext of real file.write / terminal / command traffic, and must keep the positive control
// and the completeness assertions from test/tap.mjs.
// hibernation in tests:
await relay.worker.evictDurableObject("WorkspaceDO", { name: workspaceId, webSockets: "hibernate" });
```

Tap inside the DO (test-only; gated to a local collector URL):

```ts
private tap(dir, role, conn, data) {
  const url = this.env.RELAY_TAP_URL; if (!url) return;
  let ok = false; try { ok = isLocalHostname(new URL(url).hostname); } catch {}
  if (!ok) return;
  fetch(url, { method: "POST", headers: { "x-tap-dir": dir, "x-tap-role": role, "x-tap-conn": String(conn),
    "x-tap-kind": typeof data === "string" ? "text" : "binary" },
    body: typeof data === "string" ? data : data.slice(0) }).catch(() => {});
}
```

### 6.8 Upload flow control (`test/xfer-client-proc.mjs`; the window is what keeps relay memory bounded)

```js
// frame: <u32 seq><u8 wantAck><payload>; the host acks <seq>; keep at most W frames un-acked
function pump() {
  while (next < N && (W === 0 || next - acked < W)) {
    const f = Buffer.from(payload); f.writeUInt32BE(next, 0); f[4] = W === 0 ? 0 : 1;
    ws.send(f); next++;
  }
}
ws.on("message", (d, bin) => { if (bin) { acked++; pump(); } });
```

---

## 7. How to re-run the spike

```sh
cd <spike dir>/relay
npm ci                                   # wrangler 4.142.0, jose 6.2.12, ws 8.22.0, vitest 5.0.2, typescript 7.0.2
node test/run-all.mjs                    # all checks (about 90 s): smoke, pairing, wrangler-dev, hibernation,
                                         # heartbeat (SIGSTOP), tap, auth (mock IdP), gating, limits, isolation
npx vitest run e2e/                      # harness under vitest (set XDG_CONFIG_HOME=$PWD/.xdg)
node test/close-exp2.mjs                 # close-handshake timing experiment
node test/raw-capture-pitfall.mjs        # masking demo
node test/protocol-ping.mjs              # protocol ping vs text "ping" auto-response timestamp
node test/auto-hibernate.mjs             # local auto-hibernation (25 s)
node test/startworker-alt.mjs            # deprecated unstable_startWorker, for comparison
npm run dev                              # wrangler dev --env dev on :8787 (uses .dev.vars)
npm run types                            # wrangler types && tsc -p .
node scripts/gen-key.mjs > key.json      # new Ed25519 signing JWK (prod: wrangler secret put RELAY_SIGNING_KEY < key.json)
```

- Each test starts its own workerd on a random port and closes it. SIGSTOP/SIGCONT children are always killed in `finally`. After every run, `pgrep workerd` showed nothing left.
- The spike's `.dev.vars` holds a throwaway locally generated key, not a real credential.
- Side effect: a wrangler invocation made before `XDG_CONFIG_HOME` is set creates `~/Library/Preferences/.wrangler/` (`metrics.json`, `logs/`, a skills cache). Later runs used `<spike>/.xdg`.

---

## Verification

Independent verification, 2026-09-27.

The spike was re-run from a fresh `npm ci --prefer-offline` of the same lockfile in a sibling directory, with a newly generated throwaway `.dev.vars`:
`<spike dir>/relay-verify`

The original spike directory was left untouched. Verifier-only changes in `relay-verify` are all test instrumentation, not proposed product code:
- `SPIKE_SKIP_CLOSE_REPLY` toggle in `src/room.ts`;
- `WSAUTH` decision logging and a dev-only `/__test/browser.html` page in `src/index.ts` and `src/verify-browser-page.ts`;
- `wrangler.assets.jsonc` and `public/`;
- `test/verify-*.mjs`.

`~/Library/Preferences/.wrangler` was not modified by the verifier (mtime still 22:43). No global installs. No workerd, wrangler, browse or test processes were left running.

**Verdict: the recommendation holds.** The shape, the heartbeat and alarm scheme, `createTestHarness` plus the in-relay tap, jose EdDSA and the TransferDO split all stand. The corrections below have been applied in place above.

### Confirmed (re-run by the verifier)

| Claim | Result |
|---|---|
| Full suite `node test/run-all.mjs` (V3-V5, V8-V10, V12-V23) | **ALL PASSED** on Node 25.4.0 (`verify-run1-node25.log`) and Node 22.22.1 (`verify-run2-node22.log`). SIGSTOP host offline after 6018 / 6019 ms. Across forced hibernation 5909 / 5891 ms. 32 MiB exact (33,554,433 B gives 1009). Frame cap 8 MiB + 64 KiB enforced on both DOs. `bufferedAmount` undefined in the DO. Tap completeness 40/40 with the plaintext positive control hit. |
| `wrangler dev` local, no account (V4) | Ready in 622-722 ms. Pairing passes on Node 25.4.0 and 22.22.1. |
| vitest 5.0.2 + `createTestHarness` (V23) | 1 passed on Node 25.4.0 and on 22.22.1. |
| `unstable_startWorker` still works (V24); docs mark it and `unstable_dev` deprecated | Pass. The docs statement is present in `docs-cache/workers_wrangler_api.md`. |
| API surface (V1) | `createTestHarness`, `evictDurableObject(..., {webSockets})`, `getLogs`, `update`, `reset` present in `wrangler-dist/cli.d.ts`. `wrangler types` + `tsc -p .` (TypeScript 7.0.2) exit 0. |
| Protocol ping vs text ping (V29), raw-capture masking (V16), local auto-hibernation (V7) | Reproduced exactly (`verify-misc.log`). |
| V6, re-tested strictly (the original assertion was vacuous) | Auto-responded pings do not construct a hibernated DO (it was constructed 3-10 ms after the debug call). Positive control: a binary frame wakes it. 10 pings while awake gave 0 `webSocketMessage` deliveries. |
| V10: explicit `ws.close()` in `webSocketClose` is needed locally despite the compat flag | With it: client close completes in 1-3 ms with 1000. Without it: 15,980 ms and 1006 for `ws`, 15,978 ms and 1006 for undici (`verify-close.log`). The compat-flag docs say the explicit call is "no longer required", which is not what local workerd 1.20260926.1 does for hibernatable sockets. |
| V22: dev-login hostname gate is not vacuous | Via `server.fetch("http://relay.example.com/...")`: jwks 200, dev token 404, `localhost` dev token 200. |
| V27 build size | 74.82 KiB / 19.66 KiB gzip. |
| jose EdDSA in workerd and Node (V17-V20) | Re-run; the same results and negatives. |
| Same-origin SPA via Workers static assets (previously unverified) | Works locally with `run_worker_first` for `/ws/*`, `/xfer/*`, `/auth/*`, `/api/*` and `/.well-known/*`. `assets` is inherited by `env.dev`. |

Real browser (headless Chromium 145 via gstack browse, against `createTestHarness`):
- **Auth.**
  - Dev login cookie: `HttpOnly`, `SameSite=Lax`, not `Secure` on http.
  - Same-origin cookie WebSocket gets 101 with Origin sent.
  - Same-site other-port page: the cookie **is** sent and the Origin check gives 403.
  - Cross-site (`localhost` page to `127.0.0.1` relay): no cookie is sent, 401.
- **Heartbeat and data.**
  - Text `ping` gets `pong` in 1 ms.
  - Binary echo arrives as an `ArrayBuffer` with `binaryType` set.
  - `bufferedAmount` is 16 MiB after 4 x 4 MiB sends and drains in 77 ms.
- **Close timing.**
  - Relay-initiated close: `bye` at +10 ms, `close` at +13 ms, `wasClean: true`.
  - Client-initiated close: 1 ms.

### Corrected

| Claim | Correction | Evidence |
|---|---|---|
| V11 / gotcha 2: "`ws` **and browsers** only fire `close`" after the 10-16 s FIN lag | Only Node clients do: `ws` and Node's built-in WHATWG `WebSocket` (undici), 15.9-16.0 s. Chromium fires `close` 13 ms after a relay-initiated close. `bye` is still needed for daemon and CLI. | `verify-close.log`; Chromium run |
| "Node >= 22"; vitest verified on Node 25 | vitest 5.0.2 `engines` is `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0`. Node 25 works but is unsupported (EBADENGINE on `npm ci`). Pin Node 22.12+ or 24 LTS. | `npm ci` output, `node_modules/vitest/package.json` |
| "A production DO has 128 MB"; 16 MiB in flight per workspace | 128 MB is per **isolate**, and DOs of one class may share an isolate (pricing doc, footnote 5). Lower the window to about 8 MiB per workspace. Whether outbound socket buffers count toward the limit is unverified. | `docs-cache/durable-objects_platform_pricing.md` line 69, `workers_platform_limits.md` line 121 |
| Alarm cost counted only as requests | Each `setAlarm()` is also one billed row written, which is also 100k/day on Free. | pricing doc footnote 3 under SQLite storage |
| CLI loopback code is "one-time" | It is a stateless 60 s JWT, redeemable repeatedly with the verifier: 200, 200, 200. PKCE-bound, so acceptable. Record the `jti` if true one-time use is wanted. | `verify-clicode.log` |
| Identity token `cnf` = raw device static key fingerprint | This leaks a stable device id to the relay, the exact thing `noise.md` rejected KK for (R3). Use a blinded commitment with a nonce carried inside msg3. | Design review against `noise.md` §1.2 / line 52 |
| Daemon reconnect on `bye`/`close` only (§6.6) | Insufficient. Silent path death left the host offline for more than 25 s. A 6 s pong watchdog restored `host.online` 5.2 s after the path died, once a new path was available. | `verify-blackhole.log`, `verify-blackhole2.log` |
| V14 magnitude (5 ms vs 1762 ms) | The emulator is per-connection fair queuing, a best case. The relative result holds, but on a FIFO home link typing latency during uploads also includes bufferbloat. | `test/throttle-proxy.mjs` code review |
| The vitest example asserts "never sees the marker" | Vacuous: the marker is never sent. `tap.mjs` is the real pattern. `auth.mjs` also logs, without asserting, the Origin/401/403, wrong-state and JWT-negative results. They are correct on re-run, but the product tests must assert them. | `e2e/relay.e2e.test.mjs`, `test/auth.mjs` |

### New gotchas found by the verifier

- Forced hibernation (`evictDurableObject`) fails while tap POSTs are in flight. Drain for about 500 ms first.
- `createTestHarness` loads `.dev.vars` and `.env`, and `secrets` only override them.
- Client liveness is not swept, so presence goes stale for sleeping guests.
- There is no ordering between the WorkspaceDO and TransferDO sockets.
- Never base64 chunks inside JSON under the 8 MiB cap.
- Use the same hostname for the web dev server and the relay, or cookies are not sent.
- The Origin allow-list is the only CSWSH barrier against same-site origins.
- The production top-level vars in the spike config are localhost values.
- Relay session JWTs cannot be revoked. Cap and rate-limit client sockets per workspace and per account.
- `@cloudflare/vitest-pool-workers` 0.22.0 needs vitest ^4.1 and pins wrangler 4.124.0. It is incompatible with the chosen stack.

### Still unverified

- **Real Cloudflare.**
  - Production hibernation, eviction and alarm latency.
  - Whether the 10-16 s FIN lag and the missing close auto-reply exist in production.
  - Isolate sharing and memory accounting of queued outbound WebSocket bytes.
  - DO placement of WorkspaceDO vs TransferDO.
  - WAN latency and throughput.
  - `wrangler deploy` and `wrangler secret put`.
- **Real GitHub and Google OAuth apps.** Only the mock IdP was used. The Google two-issuer branch was not exercised, because the mock uses a single issuer.
- **Other browsers and browser behavior.**
  - Firefox and Safari.
  - `Secure` cookies on `http://localhost`.
  - Chrome background-tab intensive timer throttling of the client ping loop.
  - Local Network Access prompts for the CLI loopback redirect from an https relay page.
- **Not built.** Client-liveness sweep, blinded `cnf`, and bufferbloat under a single-FIFO link emulator.
- **Cost figures.** Pricing docs only.

### How to re-run the verification

```sh
cd <spike dir>/relay-verify
export XDG_CONFIG_HOME=$PWD/.xdg WRANGLER_SEND_METRICS=false
node test/run-all.mjs                         # full original suite
node test/verify-extra.mjs                    # strict V6, ping not delivered, hostname-gate control (PRE_EVICT_SLEEP=0 reproduces the evict failure)
node test/verify-close.mjs                    # close reply needed? ws vs undici close timing
node test/verify-blackhole.mjs                # daemon pong watchdog vs silent path death
node test/verify-clicode.mjs                  # CLI code reuse
node test/verify-assets.mjs                   # SPA via static assets + relay routes
node test/verify-browser-host.mjs &           # then drive Chromium: /auth/dev/start?user=bob, /__test/browser.html?relay=..&ws=..; touch browser-stop
                                              # (run gstack browse with cwd = relay-verify: it writes a .gstack/ log dir into its cwd)
```
