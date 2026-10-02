# @smurg/relay

The smurg relay: one Cloudflare Worker and three SQLite-backed Durable Objects (`WorkspaceDO`, `TransferDO`, and
`DeviceLoginDO` for the CLI's device-code login). It handles OAuth login (and the CLI's device-code login), issues
relay sessions and identity tokens, and forwards frames per workspace that are **already end-to-end encrypted**.
The requirements are in `SPEC.md` §7.1 and R1–R3, the contract in `docs/ARCHITECTURE.md` §6, and the verified
technical details in `docs/research/relay.md`.

The relay only sees: workspace ids, connection ids, frame sizes and times, and (because login goes through it) the
account and the IP address of each connection. It never sees a key, an invite secret, a device id or any content.

smurg is open source under the MIT license, and that includes this package: **you can run your own relay**. The
project's shared relay is https://app.smurg.ai; to run one yourself, see
[Self-hosting on workers.dev](#self-hosting-on-workersdev) (no domain needed) or
[Self-hosting on your own domain](#self-hosting-on-your-own-domain).

## Architecture

- **Hibernation API only** (`ctx.acceptWebSocket`). All routing state lives in socket tags (`host`, `client`,
  `c:<conn>`), socket attachments and `ctx.storage.kv`, never in memory: both local workerd and production really
  hibernate.
- **Frames**: client → relay is plain ciphertext; relay → host is `<u32be conn><ciphertext>`; host → relay carries the
  same prefix, and the relay forwards to that client without the prefix. Control messages are JSON text frames whose
  schemas are in `@smurg/protocol/relay` (`hello`, `host.online`, `host.offline`, `peer.open`, `peer.close`,
  `peer.kick`, `bye`). Text frames are never forwarded between the two ends; an invalid control frame is dropped.
- **Heartbeat**: the text `"ping"` is answered with `"pong"` by the Durable Object's auto-response, without waking the
  object, and its time is recorded. The alarm of `WorkspaceDO` declares the host offline 6 seconds
  (`HOST_TIMEOUT_MS`) after the host's last ping and sends `host.offline {reason:"timeout"}` (measured: about 6.03
  seconds; R1 asks for 10). The same alarm closes clients that have not pinged for 30 seconds (`CLIENT_SWEEP_MS`):
  `bye 4000`, and `peer.close` to the host.
- **Host reconnects**: a new host connection always replaces the old one (the epoch goes up, the old connection gets
  `bye 4001`); close events of an old epoch are ignored.
- **The relay always sends `bye` before it closes a connection** (a Node client otherwise only sees the TCP FIN after
  10–16 seconds).
- **Frame limit**: `MAX_RELAY_FRAME` (8 MiB + 64 KiB, prefix included); a larger frame gets `bye 1009`.
- **Caps**: at most `MAX_CLIENT_SOCKETS_PER_WORKSPACE` (64) client connections per workspace per Durable Object, and
  `MAX_SOCKETS_PER_ACCOUNT` (8) per account; beyond that, HTTP 429.
- **Owner**: the first caller of `POST /api/workspaces` becomes the owner of the workspace; only the owner can open
  the host sockets (`/ws` and `/xfer`). A workspace id nobody has claimed answers 404.
- `TransferDO` only forwards file chunks, apart from interactive traffic, so that a large file cannot hold up typing
  or a terminal. The Worker asks `WorkspaceDO` for the owner and passes it on; `TransferDO` checks it again.

## Routes

| Route | Purpose |
|---|---|
| `GET /healthz` | Worker liveness |
| `GET /auth/github/login`, `GET /auth/google/login` | Browser login (optional `?return_to=/path`, or a full URL on the allow-list) |
| `GET /auth/github/callback`, `GET /auth/google/callback` | OAuth callback (the URL to register with the OAuth app) |
| `POST /auth/device/start` (JSON, the body may be empty) | First step of the CLI's device-code login; no session needed: `{ deviceCode, userCode, verificationUri, expiresIn: 600, interval: 5 }`. `userCode` is `XXXX-XXXX` (the 20 consonants of RFC 8628 §6.1), `deviceCode` is `<userCode without "-">.<base64url of 32 random bytes>`, `verificationUri` is `<relay>/device` (without the code). At most 30 per IP address in 10 minutes, then 429 `too_many_requests` with `Retry-After` |
| `POST /auth/device/token` `{ deviceCode }` | The CLI asks every `interval` seconds. Once allowed, it answers the bearer session `{ token, tokenType, expiresIn, user }` (the same shape as `POST /auth/dev/token`), **once only**; until then 400: `authorization_pending`, `slow_down` (asked more than 1 second before the interval; the interval then grows by 5 seconds), `access_denied` (the person chose to deny), `expired_token` (expired, already collected, unknown, or the secret does not match: indistinguishable), `invalid_request` (malformed) |
| `GET /device` | The relay's own page (not the SPA; no script). A browser without a session gets the relay's login methods (Google; GitHub when configured; the development login on a local hostname) and comes back to `/device` after logging in; a logged-in browser gets the form for the code. **A code in the URL is never used** (a link with the code filled in is exactly what a phishing mail would carry). `?lang=en` or `?lang=zh-TW` switches the language (see below) |
| `POST /device` (form) | Only accepts the form that `/device` itself submits: `Origin` must be the relay itself (or in `ALLOWED_ORIGINS`), and `Sec-Fetch-Site`, when present, must be `same-origin`; otherwise 403. `code`: a correct code shows the confirmation screen (the account that would be logged in, the code, the IP address and rough location the request came from, the time, and the warning to allow only a login you started yourself). `code`, `account`, `decision=allow\|deny`: allows or denies, bound to the account of this browser session (409 when `account` is not the current account). Wrong codes: 10 per account and 30 per IP address in 10 minutes, then the "too many wrong codes" page (429) |
| `GET /auth/dev/start?user=<name>[&name=<display name>][&return_to=…]`, `POST /auth/dev/token` `{ user, displayName? }` | **Development only**: `DEV_LOGIN=1` **and** a local hostname (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`); otherwise 404 |
| `POST /auth/logout` | Clears the browser cookie (204) |
| `GET /api/me` | `{ user: { userId, displayName, provider, avatarUrl? } }` or 401. It stays 401 without a session on purpose: the client SDK uses it to tell "log in again" (`probeLogin` in `engine.ts`), the CLI uses it to check a saved session, and the relay's tests assert the status |
| `GET /api/login-options` | No session needed and none is read: `{ providers: { github: boolean, google: boolean }, dev: boolean }` (schema `relayLoginOptionsSchema` in `@smurg/protocol/relay`; URL from `loginOptionsUrl()`). A provider is `true` when its configuration is complete (its login route would not answer 503); `dev` is `true` only with `DEV_LOGIN=1` **and** a local hostname on this very request (the same condition as the development login itself). Only these booleans: no client id, endpoint or other setting. `no-store`; like the other public GET routes it sends no CORS header (a page on another origin cannot read it). The web app uses it to decide which login buttons to show |
| `POST /api/workspaces` `[{ workspaceId? }]` | Claims a workspace: 201 `{ workspaceId, created: true }`, 200 when you already own it, 409 when someone else does |
| `POST /api/identity-token` `{ workspaceId, cnf }` | Identity token `{ token, expiresIn }` (see below) |
| `GET /.well-known/jwks.json` | The relay's public keys (`kid` = RFC 7638 thumbprint; public keys only), with an explicit `Date` header (the daemon estimates the relay's clock from it to check identity-token times; local workerd adds none by itself) |
| `GET /ws/<id>/host`, `GET /ws/<id>/client` | WebSocket → `WorkspaceDO` |
| `GET /xfer/<id>/host`, `GET /xfer/<id>/client` | WebSocket → `TransferDO` |
| `GET /api/debug/room?kind=ws\|xfer&workspaceId=…` | **Development only** (same condition as the development login): room state for tests |
| `GET /api/debug/device-login?code=…` (or `?limit=<kind>&key=…`), `POST …?code=…&expire=1` | **Development only** (same condition): what `DeviceLoginDO` stores, for tests (never the secret, only its hash); `expire=1` makes that login expire now (tests cannot wait 10 minutes) |

Every other path is the web SPA (`assets` in `wrangler.jsonc`; the paths the Worker handles first are
`RELAY_WORKER_FIRST_PATTERNS`).

### The relay's own pages and their language

The relay renders a few HTML pages itself: `/device` (login, the code form, the confirmation screen, the outcome
pages) and the error pages of the login routes. They exist in English and Traditional Chinese (zh-TW); every
sentence is in `src/lib/strings.ts`, with the same keys in both languages.

- **Which language**: the cookie `smurg_lang` (`en` or `zh-TW`), then the first supported entry of
  `Accept-Language` in q order, then English. The rule is `@smurg/protocol/locale`: Traditional Chinese is `zh-TW`,
  `zh-HK`, `zh-MO` and anything with `Hant`; bare `zh` and `zh-CN` are not. `<html lang>` is `en` or `zh-Hant-TW`.
- **The switch**: every page that answers a GET ends with two plain links, `English · 繁體中文`.
  `GET <page>?lang=en|zh-TW` sets `smurg_lang=<locale>; Path=/; Max-Age=31536000; SameSite=Lax; Secure` (no `Secure`
  only on a local http relay; never `HttpOnly`, because the web app on the same origin reads and writes the same
  cookie) and answers `303` to the same path without `lang`, every other query parameter kept. Any other value of
  `lang` is ignored, and so is `lang` on a POST. Pages that answer a POST show no switch; neither do the error pages
  of the OAuth callback (its URL is one-time). The links on `/device` carry nothing else from its URL.
- **No script**: the Content-Security-Policy of these pages stays `default-src 'none'; style-src 'unsafe-inline';
  form-action 'self'; base-uri 'none'; frame-ancestors 'none'`. Responses are `no-store` and carry
  `Vary: Accept-Language, Cookie`.
- **Stable hooks**: `<body data-state="…">` names the page whatever the language: `login`, `code`, `wrong-code`,
  `blocked`, `account-changed`, `confirm`, `allowed`, `denied`, `gone`, `error`; the `data-testid`s are unchanged.
- **The JSON API never picks a language**: its errors are codes (`{ "error": "<code>", "message"? }`) with fixed
  English messages for logs. Clients show their own text for a code.
- A user without a usable name from Google is called `Google user` in both languages (a stored name has one
  spelling).

### CLI device-code login

`smurg login` (and `smurg host` or `smurg attach` when they need a login) prints `<relay>/device` and a code, opens
that address (without the code) on a machine with a desktop, and then asks `POST /auth/device/token` every 5
seconds. The person logs in to the relay in a browser on any device, enters the code, reads the confirmation screen
and allows the login: the CLI gets the account of that browser session. The browser never has to reach the machine
the CLI runs on, so it works over SSH without forwarding a port.

- **State**: `DeviceLoginDO` (SQLite-backed, migration `v2` in `wrangler.jsonc`). The Worker gets two kinds of
  objects by name. `code:<code>` is one login (the code is the name, so `/device` finds it from what the person
  typed and the token endpoint from the device code); it stores the SHA-256 of the device code's secret (compared in
  constant time), the creation time, `CF-Connecting-IP` and Cloudflare's guess of country and city, and after the
  decision the outcome and the account that allowed it. It is deleted when the CLI collects the result, or by its
  alarm after 10 minutes. `limit:<kind>:<SHA-256>` is a 10-minute counter (IP addresses and accounts only appear
  hashed in the name), deleted by its alarm when the window ends. An object sets one alarm, only while it holds data;
  there is no periodic alarm.
- **Cost** (Free plan): starting a login is about 2 Durable Object requests and 3 rows written (record, counter,
  alarm). Each poll of the CLI is 1 Worker request and 1 Durable Object request and **writes nothing** (the time of
  the previous poll is only kept in memory; when the object is evicted it is forgotten, and the next poll is not
  "too fast"); at most about 120 in 10 minutes. Entering the code and allowing or denying are about 3–5 Durable
  Object requests each.
- **Why the code is never prefilled**: anyone can make a `/device?code=…` link, and an attacker would send people a
  link carrying the attacker's own code. The code must be typed into the page, and the confirmation screen says where
  the request came from and how long ago.
- **Same-origin forms**: every state change of `/device` is a same-origin form POST (`Origin` is the relay itself or
  in `ALLOWED_ORIGINS`; `Sec-Fetch-Site`, when present, is `same-origin`); the CSP has `frame-ancestors 'none'`, next
  to `X-Frame-Options: DENY`. The `Referrer-Policy` of these pages is `same-origin`: under `no-referrer` a browser
  sends `Origin: null` with a form POST (the Fetch specification; measured in Chrome), and the same-origin check
  would refuse the legitimate request too.
- **The loopback login is gone**: the CLI loopback login of smurg 0.1.0 (`/auth/cli/start`, `/auth/cli/token`) was
  removed from the relay; those paths answer 404.
- Tests: `test/device.test.ts` and `test/pages.test.ts` (workerd), `test/cli-login.browser.test.ts` (Chrome and the
  real CLI), `tests/e2e/test/device-login.test.ts`, `apps/web/e2e/smoke/login.smoke.test.ts`.

### Sessions

- A relay session is an EdDSA JWT (`typ: smurg-session+jwt`, `aud: smurg-relay`, 7 days). It is stateless and cannot
  be revoked before it expires; removing someone is the daemon's job (it revokes the device key and sends
  `peer.kick`).
- Browsers: an `HttpOnly; SameSite=Lax` cookie (with `Secure` and the `__Host-` prefix when the issuer is https). To
  open a WebSocket with the cookie, or to send a state-changing request (POST) with it, `Origin` **must** be in
  `ALLOWED_ORIGINS`, else 403: other origins of the same site also carry a Lax cookie, so the Origin allow-list is
  the real defence against CSWSH and CSRF.
- CLI and daemon: `Authorization: Bearer <token>`, no Origin needed. A malformed Authorization header or an invalid
  token is 401 straight away; the relay does not fall back to the cookie.
- A `dev:` identity is only valid on a relay where the development login is on (defence in depth).

### Identity tokens

`POST /api/identity-token { workspaceId, cnf }` answers an EdDSA JWT: `typ: smurg-identity+jwt`,
`iss: <relay origin>`, `aud: smurg-daemon:<workspaceId>`, 5 minutes, `sub` (the user id), `name`, `provider`,
`picture?`, `jti`, and `cnf: { "smurg-noise-static": <cnf> }`.

`cnf` is a **blinded commitment**: `base64url(SHA-256("smurg-cnf" ‖ n ‖ the device's Noise static public key))`,
where `n` is 32 random bytes that only travel inside the encrypted msg3 to the daemon. The relay therefore sees no
stable device id. The daemon verifies it like this:

```ts
const jwks = createRemoteJWKSet(new URL(`${relayOrigin}/.well-known/jwks.json`));
const { payload } = await jwtVerify(token, jwks, {
  issuer: relayOrigin, audience: `smurg-daemon:${workspaceId}`,
  typ: 'smurg-identity+jwt', algorithms: ['EdDSA'], maxTokenAge: '5m',
});
// Then: payload.cnf['smurg-noise-static'] must equal the commitment computed from n and the Noise remote static
// public key this connection has authenticated.
```

## Configuration

The top level of `wrangler.jsonc` holds the **production** values of the project's shared relay (the custom domain
app.smurg.ai, Workers Free plan, Google login only); `env.dev` holds the local values only (`vars`,
`durable_objects` and `secrets` are not inherited, so `env.dev` lists them all again; `routes` is inherited, so
`env.dev` says `"routes": []`; locally you may also use a GitHub OAuth app of your own).

**To run your own relay you must change two things in the top level of `wrangler.jsonc`: the hostname (`workers_dev`
/ `routes`, with `RELAY_ISSUER` and `ALLOWED_ORIGINS`) and `GOOGLE_CLIENT_ID`.** The committed values belong to the
shared relay: its domain is on the maintainer's Cloudflare account, and its Google client only accepts
`https://app.smurg.ai`. The two self-hosting sections below list the exact lines.

| Name | Kind | Shared relay | Meaning |
|---|---|---|---|
| `workers_dev`, `routes` | config | `false`; `[{ "pattern": "app.smurg.ai", "custom_domain": true }]` | The relay's one public hostname: one Cloudflare Custom Domain, or `workers_dev: true` without `routes`. See [Deploying to Cloudflare](#deploying-to-cloudflare) |
| `RELAY_ISSUER` | var | `https://app.smurg.ai` (custom domain: `https://<domain>`; workers.dev: `""` before the first deploy, then `https://smurg-relay.<subdomain>.workers.dev`, written by `scripts/deploy-relay.sh`) | The relay's origin: the JWT `iss` and the base of the OAuth callback URL. https only (http on this machine), no path. When it is empty or wrong, every relay route except `/healthz` and the web app answers 500 |
| `ALLOWED_ORIGINS` | var | the same as `RELAY_ISSUER` (written together) | Comma-separated: the browser origins that may use a cookie session. Malformed or non-https entries are skipped |
| `DEV_LOGIN` | var | `"0"` | The development login is on only with `"1"` and a local hostname |
| `RELAY_TAP_URL` | var | `""` | The **test-only** R3 byte tap (see the last section); a URL that is not local counts as off |
| `HOST_TIMEOUT_MS`, `CLIENT_SWEEP_MS` | var | 6000, 30000 | Equal to the constants of `@smurg/protocol` |
| `MAX_CLIENT_SOCKETS_PER_WORKSPACE`, `MAX_SOCKETS_PER_ACCOUNT` | var | 64, 8 | |
| `GOOGLE_CLIENT_ID` | var | the shared relay's client; your own is written by `scripts/deploy-relay.sh --google-client-id` | The OAuth client ID (public) |
| `GOOGLE_*_URL`, `GOOGLE_ISSUER` | var | Google's real endpoints | Service endpoints; the tests point them at a mock IdP |
| `GITHUB_CLIENT_ID`, `GITHUB_*_URL` | var | **none** (GitHub login is off) | Only in `env.dev` |
| `RELAY_SIGNING_KEY` | secret (required) | `wrangler secret put` (see [Deploying to Cloudflare](#deploying-to-cloudflare)) | An Ed25519 private JWK. It may also be `{"keys":[new private key, old public key…]}`: the first key signs, all of them are published in the JWKS and used to verify (rotating the key then logs nobody out) |
| `GOOGLE_CLIENT_SECRET` | secret (optional) | `wrangler secret put` (same) | Without it Google login is off (503): the relay never calls Google with an empty client secret |
| `GITHUB_CLIENT_SECRET` | secret (optional) | not set | Local only (`.dev.vars`) |

A configuration problem always means "off": with an invalid issuer every login route answers 500; when one
provider's configuration is incomplete or an endpoint is not https, only that provider is off.

## Local development

```sh
source scripts/env.sh
pnpm dev:relay          # wrangler dev --env dev on 127.0.0.1:8787 (SMURG_RELAY_DEV_PORT changes the port)
pnpm dev:web            # Vite on localhost:5173, proxying the relay's paths to 8787
```

- The first `pnpm dev:relay` creates `apps/relay/.dev.vars` (mode 0600) with a fresh development
  `RELAY_SIGNING_KEY` when the file does not exist. An existing file is never changed. The template is
  `.dev.vars.example` (placeholders only).
- Development login: open `http://localhost:5173/auth/dev/start?user=amy&return_to=http://localhost:5173/` in a
  browser, or
  `curl -X POST -H 'content-type: application/json' -d '{"user":"amy"}' http://localhost:8787/auth/dev/token`.
- Use the same hostname for the web dev server and the relay (`localhost` for both), or the cookie is not sent.
- Never put a production key into `.dev.vars`; the tests do not read that file.

## Deploying to Cloudflare

A relay is one Worker on one Cloudflare account (the Workers **Free** plan is enough to start), with Google as its
only login (an OAuth client that the person deploying creates). The same Worker serves the web app (the build of
`apps/web`), so the web app, login and the WebSockets share one origin. A relay has **exactly one public hostname**,
decided by the top level of `wrangler.jsonc`; `scripts/deploy-relay.sh` accepts the two shapes below and refuses
anything else:

| Shape | Top level of `wrangler.jsonc` | URL | Used for |
|---|---|---|---|
| workers.dev | `"workers_dev": true`; no `"routes"`; `RELAY_ISSUER` and `ALLOWED_ORIGINS` are `""` before the first deploy | `https://smurg-relay.<subdomain>.workers.dev` | **The default for your own relay**: no domain needed. [Self-hosting on workers.dev](#self-hosting-on-workersdev) |
| Custom domain | `"workers_dev": false`; `"routes"` is exactly one `{ "pattern": "<domain>", "custom_domain": true }`; `RELAY_ISSUER` and `ALLOWED_ORIGINS` are both `https://<domain>` | `https://<domain>` | Your own relay on a domain whose zone is on the same Cloudflare account ([Self-hosting on your own domain](#self-hosting-on-your-own-domain)), and **the project's shared relay https://app.smurg.ai** (the committed `wrangler.jsonc` has this shape; until 2026-10-01 the shared relay was a `https://<name>.<account>.workers.dev` URL, which answers 404 now) |

Both shapes keep `preview_urls` off (every version would get one more public URL in front of the same Durable
Objects), and never have workers.dev and a custom domain on together.

Always deploy with `scripts/deploy-relay.sh` from the repository root (it sources `scripts/env.sh`). It is safe to
run again:

- It **never** runs `wrangler login` or `wrangler secret put`, and never reads, prints, writes or passes a secret:
  when one is needed it prints the command for you to run.
- `wrangler deploy` applies the Durable Object migrations in order, each tag once: `v1` (`WorkspaceDO`,
  `TransferDO`) **must not change** once it is deployed; `v2` (`DeviceLoginDO`, the device-code login) is created by
  the first deploy after it, with no extra command. A new class always gets a new tag with `new_sqlite_classes` (the
  Free plan only allows SQLite-backed classes); the check of step 3 accepts exactly `v1` and `v2`.
- wrangler keeps its login in the repository's `.xdg/` (`scripts/env.sh` sets `XDG_CONFIG_HOME`; `.xdg/` is in
  `.gitignore`), not in your home directory.

### The first two steps, for every shape

Everything below runs from the repository root, in a terminal where you have run `source scripts/env.sh`.

1. **Log in to Cloudflare** (this opens Cloudflare's authorization page in a browser):
   ```sh
   CI=false pnpm --filter @smurg/relay exec wrangler login
   ```
   `CI=false`: `scripts/env.sh` sets `CI=true`, and wrangler does nothing interactive in CI mode. When the login can
   use several accounts, put `CLOUDFLARE_ACCOUNT_ID=<account ID>` in front of every later command
   (`pnpm --filter @smurg/relay exec wrangler whoami` lists them).
2. **Put the signing key** (the key only goes through the pipe to wrangler; it never appears on screen or in a file):
   ```sh
   node apps/relay/scripts/signing-key.ts | pnpm --filter @smurg/relay exec wrangler secret put RELAY_SIGNING_KEY --env=""
   ```
   This must come before the first deploy: `secrets.required` in `wrangler.jsonc` lists `RELAY_SIGNING_KEY`, and
   wrangler 4.142 refuses a first deploy without it; when the Worker does not exist yet, `wrangler secret put`
   creates an empty `smurg-relay` Worker first and then stores the key. `signing-key.ts` prints an Ed25519 private
   JWK (`kty`, `crv`, `x`, `d`, `kid` = RFC 7638 thumbprint), exactly the format the relay reads (`src/auth/keys.ts`;
   checked by `test/build.test.ts`).

## Self-hosting on workers.dev

Your own relay without a domain of your own: it runs at `https://smurg-relay.<your subdomain>.workers.dev`. The
committed `wrangler.jsonc` is the shared relay's, so first change these lines at its top level (keep the change in
your own branch or fork):

```jsonc
"workers_dev": true,          // was false
                              // delete the line  "routes": [{ "pattern": "app.smurg.ai", "custom_domain": true }],
"RELAY_ISSUER": "",           // in vars: was https://app.smurg.ai
"ALLOWED_ORIGINS": "",
"GOOGLE_CLIENT_ID": "",       // the shared relay's client ID does not work for your relay
```

3. **Deploy for the first time** (after steps 1 and 2 above):
   ```sh
   scripts/deploy-relay.sh
   ```
   `RELAY_ISSUER` is still empty, so the script deploys once (the relay is closed at this point: everything except
   `/healthz` and the web app answers 500, and nobody can log in), learns the workers.dev URL from the deploy result,
   writes it into `wrangler.jsonc`, deploys again, and finally prints the URL and the two values Google needs and
   checks the relay from outside (Google login is still off at this point, as expected). If you already know your
   subdomain, `scripts/deploy-relay.sh --url https://smurg-relay.<subdomain>.workers.dev` deploys only once. When the
   account has no workers.dev subdomain yet, wrangler fails and prints
   `https://dash.cloudflare.com/<account>/workers/onboarding`: choose a subdomain there and run the script again.
4. **Create the Google OAuth client** ([Google OAuth client](#google-oauth-client)) with the JavaScript origin and
   the redirect URI that step 3 printed.
5. **Put Google's client secret** (paste it at `Enter a secret value:`; it is not shown):
   ```sh
   CI=false pnpm --filter @smurg/relay exec wrangler secret put GOOGLE_CLIENT_SECRET --env=""
   ```
6. **Write the client ID and deploy once more**:
   ```sh
   scripts/deploy-relay.sh --google-client-id <client ID>.apps.googleusercontent.com
   ```
   When every check passes it prints `Done: …`.
7. Keep your edited `apps/relay/wrangler.jsonc` (the URL and the client ID are public). A host points smurg at your
   relay with `smurg login --relay <your URL>` (the invite links it prints then lead to your relay). To make a CLI
   you build yourself use it by default, set `DEFAULT_RELAY_URL` in `packages/cli/src/relay/default-relay.ts` to
   that URL (the script prints the line).

## Self-hosting on your own domain

When the zone of a domain is on the same Cloudflare account, your relay can live on a hostname of it (for example
`relay.example.edu`). Change these lines at the top level of `wrangler.jsonc`:

```jsonc
"workers_dev": false,                                                   // stays false
"routes": [{ "pattern": "relay.example.edu", "custom_domain": true }],  // your hostname instead of app.smurg.ai
"RELAY_ISSUER": "https://relay.example.edu",                            // in vars
"ALLOWED_ORIGINS": "https://relay.example.edu",
"GOOGLE_CLIENT_ID": "",                                                 // the shared relay's client ID does not work for your relay
```

The URL is known up front, so there is no "deploy once to learn it".

3. **The zone** is on the same Cloudflare account (Websites, status Active): the deploy attaches the custom domain
   to the Worker, and Cloudflare creates the DNS record and the certificate. The wrangler this script runs
   (`CI=true`) **does not ask**: an existing DNS record at that hostname, or another Worker's custom domain, is
   simply replaced by the relay (`publishCustomDomains` in wrangler 4.142). So before it deploys, the script looks at
   who answers at the hostname now: it continues when there is no DNS record yet or when it already is a smurg relay,
   and otherwise stops and explains (add `--take-over-hostname` when you do want the relay to take the hostname).
   Zone settings (dashboard, once): **SSL/TLS → Edge Certificates → Always Use HTTPS on** (workers.dev is under
   `.dev`, where browsers only use https anyway; a custom domain has no such protection, and without the setting
   `http://` answers with the web app itself, which anyone on the network could replace); **Bot Fight Mode off, no
   I'm Under Attack, no WAF rule that challenges this hostname** (the CLI and the daemon are not browsers and cannot
   pass a challenge). The outside checks (step 10, `--check`) test the first, and say so when Cloudflare stops a
   request.
4. **The Google OAuth client** ([Google OAuth client](#google-oauth-client)): Authorized JavaScript origins
   `https://<your hostname>`, Authorized redirect URIs `https://<your hostname>/auth/google/callback`, Authorized
   domains (Branding) the domain you own that the hostname belongs to; then put the client secret:
   ```sh
   CI=false pnpm --filter @smurg/relay exec wrangler secret put GOOGLE_CLIENT_SECRET --env=""
   ```
5. **Deploy**:
   ```sh
   scripts/deploy-relay.sh --google-client-id <client ID>.apps.googleusercontent.com
   scripts/deploy-relay.sh --check https://<your hostname>    # any time later: only the checks from outside
   ```
   The script deploys once and makes sure wrangler's result is exactly the custom domain
   (`<your hostname> (custom domain)`) with no workers.dev URL. A new custom domain (DNS and certificate) can take a
   few minutes to come up; the outside checks retry for 180 seconds by default. `--url`, when given, must be exactly
   `https://<your hostname>`. When everything passes it prints `Done: …`.
6. As step 7 of the workers.dev section: keep your `wrangler.jsonc`, and point smurg at the relay with
   `smurg login --relay https://<your hostname>`.

## The shared relay (app.smurg.ai, maintainers)

The committed `wrangler.jsonc` is the deployed configuration of the project's shared relay (`workers_dev: false`,
the custom domain `app.smurg.ai`, `RELAY_ISSUER` and `ALLOWED_ORIGINS` `https://app.smurg.ai`, the shared relay's
`GOOGLE_CLIENT_ID`). Only the maintainer can deploy it: the zone `smurg.ai` is on the maintainer's Cloudflare
account, and `scripts/deploy-relay.sh` refuses a hostname that something other than a smurg relay answers at. The
steps are those of [Self-hosting on your own domain](#self-hosting-on-your-own-domain) with nothing to edit:

```sh
scripts/deploy-relay.sh                                 # with a new client: --google-client-id <client ID>, then commit wrangler.jsonc
scripts/deploy-relay.sh --check https://app.smurg.ai    # any time later: only the checks from outside
```

Google: Authorized JavaScript origins `https://app.smurg.ai`, Authorized redirect URIs
`https://app.smurg.ai/auth/google/callback`, Authorized domains `smurg.ai`. "Every check passes" includes that the
live web app is the build of this checkout: before each release, deploy again from that commit (an older web app
refuses a newer daemon; `docs/RELEASING.md`). The web app is built from the working tree, so deploy from a clean
checkout (`git status` prints nothing).

## Google OAuth client

Google's console is renamed now and then: the names below are those under "APIs & Services", with the newer "Google
Auth Platform" names next to them. These screens were not operated from the development environment.

1. Open https://console.cloud.google.com/ , the project menu at the top → **New project** (a name such as
   `smurg-relay`) → switch to it once it is created.
2. **Consent screen**: APIs & Services → **OAuth consent screen** (newer: **Google Auth Platform → Get started**,
   then **Branding** and **Audience**):
   - App name (what people see when they log in, for example `smurg`), User support email, Developer contact email.
   - User type / Audience: **External**.
   - Scopes (Data Access): nothing to add. The relay only asks for `openid`, `email` and `profile`, all non-sensitive.
   - **Testing or In production**: a new app is in Testing, where only the Google accounts listed under **Test
     users** (at most 100) can log in, which suits a first try; to let everyone log in, press **Publish app** under
     Audience (older: OAuth consent screen) to move it to In production. With only the three non-sensitive scopes
     above Google normally asks for no review (not verified here).
   - **Authorized domains** (Branding): for a relay on a custom domain, add the domain you own that it belongs to
     (the shared relay: `smurg.ai`).
3. **Create the client**: APIs & Services → **Credentials → Create credentials → OAuth client ID** (newer: **Clients
   → Create client**):
   - Application type: **Web application**; any name (for example `smurg relay`).
   - **Authorized JavaScript origins**: the relay's URL, for example `https://relay.example.edu` or
     `https://smurg-relay.<subdomain>.workers.dev` (`scripts/deploy-relay.sh` prints it).
   - **Authorized redirect URIs**: the relay's URL followed by `/auth/google/callback`, for example
     `https://relay.example.edu/auth/google/callback`.
   - Press **Create**. The **Client ID** is public: give it to the deploy script with `--google-client-id`. The
     **Client secret** is a secret: paste it only into `wrangler secret put GOOGLE_CLIENT_SECRET`, never into a file,
     a chat or an issue.
4. The relay logs in with state + nonce + PKCE and verifies the `id_token` against Google's JWKS (`iss` may be
   `https://accounts.google.com` or `accounts.google.com`; `aud` must be its own client ID). The CLI's login needs no
   extra URL: the CLI logs in by device code, and the person logs in on the relay's `/device` page through the same
   `/auth/google/callback`.

## What `scripts/deploy-relay.sh` does

| Step | What happens |
|---|---|
| 1 | `wrangler whoami --json`: without a login it prints the login command and stops (exit code 3); with several accounts and no `CLOUDFLARE_ACCOUNT_ID` it lists the accounts and stops |
| 2 | `wrangler secret list`: when the Worker does not exist yet or has no `RELAY_SIGNING_KEY`, it prints the command of step 2 above and stops (exit code 3) |
| 3 | Checks the top level of `wrangler.jsonc`: one of the two shapes (custom domain: `workers_dev: false`, exactly one `{ pattern, custom_domain: true }` route, `RELAY_ISSUER` is `https://<domain>`; workers.dev: `workers_dev: true`, no routes, `RELAY_ISSUER` empty or this Worker's workers.dev URL; `--url` must fit that shape), `preview_urls: false`, `DEV_LOGIN` `"0"`, `RELAY_TAP_URL` empty, no `GITHUB_*`, Google's real endpoints, `ALLOWED_ORIGINS` equal to `RELAY_ISSUER`, `secrets.required`, the three SQLite Durable Objects with exactly the migrations `v1` and `v2`, the SPA assets and `run_worker_first` (`test/config.test.ts` makes the same checks on the committed file) |
| 4 | `pnpm --filter @smurg/web build`, then `scripts/check-web-dist.ts`: it must be a real build, with a `_headers` that has a CSP with `frame-ancestors 'none'` and a `Strict-Transport-Security` of at least a year, and must not serve `.vite/`. It notes the `/assets/…` files that `index.html` loads (their names contain a content hash; step 10 compares them) |
| 5 | The URL. Custom domain: `https://<the domain in routes>`, and then who answers there now (a DNS lookup; with a record, also `/healthz` and `/api/login-options`): it continues when there is no DNS record or it already is a smurg relay, and otherwise stops (exit code 3), because the wrangler this script runs would take the hostname over without asking (`--take-over-hostname` deploys anyway; `--dry-run` does not look). workers.dev: `--url`, else `RELAY_ISSUER` in `wrangler.jsonc`, else one first deploy (empty issuer, relay closed) whose result wrangler writes to `WRANGLER_OUTPUT_FILE_PATH` (`{"type":"deploy","targets":[…]}`). wrangler has no command that prints an account's workers.dev subdomain: `wrangler whoami` only lists accounts |
| 6 | Writes `RELAY_ISSUER`, `ALLOWED_ORIGINS` (the workers.dev URL; a custom domain's are already there) and `GOOGLE_CLIENT_ID` (`--google-client-id`) into the top-level `vars` of `wrangler.jsonc`: only those lines change; comments, `workers_dev`, `routes` and `env.dev` stay; the result is parsed again and compared before it is written |
| 7 | `wrangler deploy --env ""`; the deploy result must be exactly that URL, or the script stops and explains: the workers.dev URL equal to `RELAY_ISSUER` (different: the account's subdomain changed), or the custom domain as `<domain> (custom domain)` (the spelling of wrangler 4.142) and no workers.dev URL |
| 8 | Prints the URL, Google's JavaScript origin and redirect URI (and, for a custom domain, a reminder of the authorized domain), and the `DEFAULT_RELAY_URL` line for the CLI when it differs from this URL |
| 9 | Looks at the secrets again and prints the command for a missing one |
| 10 | Checks from outside (a new workers.dev hostname or custom domain can take minutes to come up; retries for 180 seconds by default, `--wait` changes that): `/healthz`; `/api/login-options` is `google: true, github: false, dev: false`; `/.well-known/jwks.json` has Ed25519 public keys and no private field; `/` and an SPA deep link are the web app's `index.html` with the `Content-Security-Policy` of `_headers` (`frame-ancestors 'none'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff` and, on an https relay, `Strict-Transport-Security` (`max-age` at least 31536000; of two such headers only the first counts, as in a browser; a local http relay is not asked); `/auth/google/login` redirects to Google with this relay's `/auth/google/callback` as `redirect_uri`, the configured `client_id`, and a `Secure` cookie whose name starts with `__Host-`; the live web app is the build of step 4 (`/` loads the same `/assets/…` files); on a custom domain `http://…/healthz` answers 301 or 308 to the same `https://` URL (the zone's Always Use HTTPS; workers.dev needs none). When Cloudflare itself stops a request (the response has `cf-mitigated`), that check fails and says why |

The names of the outside checks are stable (`CHECK_NAMES` in `scripts/deploy.ts`): `GET /healthz`,
`GET /api/login-options`, `GET /.well-known/jwks.json`, `GET / (web app and CSP)`,
`GET /join/... (SPA deep link and CSP)`, `GET /auth/google/login`, `GET / (web app is the build of this checkout)`,
`http:// redirects to https://`. The script's messages are English only (it is a maintainer's and operator's tool).

**Vars at deploy time**: nothing is passed with `--var`. Production runs exactly the values committed at the top
level of `wrangler.jsonc`; before a deploy the script only writes `RELAY_ISSUER`, `ALLOWED_ORIGINS` (workers.dev:
when it first learns the URL, or when `--url` changes it) and `GOOGLE_CLIENT_ID` (`--google-client-id`) into that
file. The one exception is the very first workers.dev deploy, before the URL is known: it uses the file as it is,
with the empty issuer (the relay is closed). `keep_vars` is off, so a var edited by hand in the Cloudflare dashboard
is overwritten by the value in `wrangler.jsonc` at the next deploy. Secrets are not touched by a deploy.

Other modes, and the exit codes:

```sh
scripts/deploy-relay.sh --dry-run [--url …] [--google-client-id …]   # builds the web app, checks the config, wrangler deploy --dry-run; no contact with the Cloudflare account (no login or secret check), no deploy, no file change
scripts/deploy-relay.sh --check https://<relay host>   # only step 10 (expects Google login on)
```

`--check` compares the web app with `apps/web/dist` of this checkout (or `--web-dist <dir>`); when that holds no
build (missing, the stand-in page, no `index.html`) it does not compare, and says so. A directory that
`scripts/check-web-dist.ts` would refuse but that is a build (for example one from before
`apps/web/public/_headers` had HSTS) is still compared, with a `Note:` that gives the reason: it may be older than
this checkout, so run `pnpm --filter @smurg/web build` first and compare again.

0 done (while Google is not set up yet, the next steps are printed), 1 failed, 2 wrong arguments, 3 you have to do
something first (log in, choose an account, put the signing key, or something else already answers at the custom
domain).

Every step of the script runs in `test/deploy-relay.test.ts` against a fake wrangler (which answers in the output
formats of wrangler 4.142's source) and a local relay configured like production, in both shapes (the committed
custom-domain configuration, and the same file turned into the workers.dev shape). Against a real Cloudflare
account, the workers.dev shape ran when the shared relay was first deployed on 2026-10-01; the move to app.smurg.ai
on the same day was made with `wrangler deploy` directly, so the custom-domain path of the script first meets a real
account at the next deploy of the shared relay.

**Every deploy drops all WebSockets** (`docs/research/relay.md`, gotcha 9): hosts, teammates' web apps and CLIs
reconnect by themselves, but a transfer in progress starts over. To only look at the state, use `--check` instead of
deploying again.

## Afterwards

- **Updating a relay**: get the new code and run `scripts/deploy-relay.sh` from a clean checkout (the URL and the
  client ID are already in `wrangler.jsonc`; on your own relay, keep the lines you changed). The relay's web app
  must be at least as new as the smurg of the hosts who use it: the web app reads the daemon's messages strictly, so
  an older web app refuses the extra fields of a newer daemon (a newer web app accepts an older daemon).
- **Rotating the signing key**: simply replacing it logs everybody out. To keep logins, first put
  `RELAY_SIGNING_KEY` as `{"keys":[new private key, old public key]}` (see [Configuration](#configuration)), and
  after 7 days (the session lifetime) put only the new private key.
- **Rotating the Google client secret**: add a secret in the Google Cloud console, then put it with
  `wrangler secret put GOOGLE_CLIENT_SECRET`.
- **Google login only**: a relay deployed by this script uses Google login only. GitHub login would need GitHub vars
  at the top level of `wrangler.jsonc`, which the script's check refuses (it deploys the Google-only configuration
  the project decided on).
- **Changing the URL** (between workers.dev and a custom domain, or to another domain): change the shape in
  `wrangler.jsonc` (the table above) with `RELAY_ISSUER` and `ALLOWED_ORIGINS`, and the origin and redirect URI of
  the Google OAuth client. Invite links of the old URL stop working, and the CLI's built-in relay is compiled into
  the executable. For someone who logged in to the old URL with the CLI, the CLI keeps choosing the relay of the
  last login (it ranks before the built-in one): they run `smurg login --relay <new URL>` (or first
  `smurg logout --relay <old URL>`).

## Workers Free plan limits

The numbers come from Cloudflare's documentation (the August–September 2026 editions; copies were kept by the
research in `docs/research/relay.md`). The relay's own usage is estimated from the code and was **not measured on
Cloudflare**.

| Limit (Free) | Value | Beyond it |
|---|---|---|
| Worker requests | 100,000 per day for the whole account, reset at 00:00 UTC | Cloudflare error 1027 until the reset |
| CPU time per request | 10 ms | Error 1102. A relay request signs or verifies with Ed25519, and the Google login callback also verifies RS256; whether all of them stay under 10 ms was not measured |
| Durable Object requests | 100,000 per day: HTTP requests, RPC, **every run of an alarm**, and incoming WebSocket messages (20 count as 1) | Such operations fail until 00:00 UTC |
| Durable Object duration | 13,000 GB-s per day (the relay only uses the Hibernation API; an idle object is not billed) | Same |
| SQLite rows written | 100,000 per day: **each `setAlarm()` is 1 row**, and writes to `storage.kv` count too | Same |
| SQLite rows read, storage | 5 million rows per day, 5 GB in total | Same |
| Static assets | 20,000 files per version, 25 MiB each, 100 rules in `_headers` | The deploy fails |

The relay's usage (estimated):

- While a host is online and at least one teammate is connected, the alarm of `WorkspaceDO` fires 6 seconds after
  the host's last ping (the host pings every 2 seconds), so about every 4–6 seconds: about **14,000–22,000 alarms
  (= requests) per workspace per day, and as many SQLite rows written**. By this item alone the Free plan carries
  about **4–7 workspaces that have people connected all day**. `TransferDO` fires about every 30 seconds while a
  transfer connection is open. No alarm is set while no teammate is connected.
- Each WebSocket connection costs 1 Worker request and 1 Durable Object request when it opens; login, creating a
  workspace, an identity token and the other API calls are 1 Worker request each.
- The device-code login: see "Cost" under [CLI device-code login](#cli-device-code-login) (at most about 120 polls
  per login, each 1 Worker request and 1 Durable Object request, nothing written).
- Heartbeats (the text `"ping"`) are answered by the auto-response and are not billed. Every message of typing,
  terminal output and file transfer (in the direction into the Durable Object, including what the host sends to
  teammates) counts as 1/20 of a request: one terminal that keeps printing can use tens of thousands in a day.
- The web app's static files do not go through the Worker (`run_worker_first` only lists the relay's paths);
  whether they count towards the 100,000 per day was not verified here.

In short: the Free plan suits trying smurg out, a class demonstration and a few teams. With several workspaces in
use all day it reaches a limit, and nobody can connect for the rest of that day; the Workers Paid plan lifts it
without any change to the code or to `wrangler.jsonc` (SQLite Durable Objects work on both plans). The Cloudflare
dashboard shows each day's usage under Workers & Pages → smurg-relay → Metrics.

## Troubleshooting

| What you see | Cause and what to do |
|---|---|
| `wrangler is not logged in to Cloudflare` | Step 1. Run `source scripts/env.sh` first, so that the login is kept in the repository's `.xdg/` (the only place the script looks) |
| `This account has no Worker named smurg-relay yet.`, `required secrets have not been set: RELAY_SIGNING_KEY` | Step 2 |
| `wrangler.jsonc is not fit for production`, naming `workers_dev`, `routes` or `RELAY_ISSUER` | The configuration has neither shape. Custom domain: `workers_dev: false`, exactly one custom domain route, `RELAY_ISSUER` is `https://<that domain>`. workers.dev: `workers_dev: true`, `routes` deleted, `RELAY_ISSUER` is `""` or this Worker's workers.dev URL |
| `--url … is not the custom domain of wrangler.jsonc` or `is not https://smurg-relay.<subdomain>.workers.dev` | `--url` does not fit the shape of the configuration: edit `wrangler.jsonc` as the message says ([Self-hosting on workers.dev](#self-hosting-on-workersdev), [Self-hosting on your own domain](#self-hosting-on-your-own-domain)), or leave `--url` out |
| `You need to register a workers.dev subdomain` | Open the `https://dash.cloudflare.com/<account>/workers/onboarding` page that wrangler printed, choose a subdomain, and run the script again |
| `Could not find zone for …`, `the deploy result does not list the custom domain … (custom domain)` | The zone of the domain is not on this Cloudflare account (or Cloudflare is not its DNS): check in the dashboard and run the script again |
| `Something already answers at …, and it is not a smurg relay` | The hostname already has a DNS record or another Worker's custom domain. The wrangler this script runs would replace it with the relay without asking, so the script stops first. To keep it: use another domain. To take it over: remove the old record in the dashboard, or add `--take-over-hostname` |
| ✗ `GET / (web app is the build of this checkout)` | The live web app is not the build of this checkout: deploy again from a clean checkout of the commit you want. When only `apps/web/dist` is stale (or holds uncommitted changes): `pnpm --filter @smurg/web build`, then `--check` again |
| ✗ `http:// redirects to https://` | The zone of the custom domain does not have SSL/TLS → Edge Certificates → Always Use HTTPS on |
| ✗ `GET / (web app and CSP)` saying `Strict-Transport-Security` is missing | The live web app was built before `apps/web/public/_headers` had HSTS: deploy again from the commit to release |
| `cf-mitigated` | Cloudflare's Bot Fight Mode, I'm Under Attack or a WAF rule stopped the request: turn it off for the relay's hostname (the CLI and the daemon cannot pass a challenge) |
| `wrangler secret put` or `wrangler login` fails before it asks anything | Put `CI=false` in front of the command (`scripts/env.sh` sets `CI=true`) |
| `--check` reports HTTP 500 for `/api/login-options` | `RELAY_ISSUER` is empty, or `RELAY_SIGNING_KEY` is wrong: run `scripts/deploy-relay.sh` again |
| `google=false` | `GOOGLE_CLIENT_SECRET` is missing (`wrangler secret put GOOGLE_CLIENT_SECRET`), or `GOOGLE_CLIENT_ID` is (`--google-client-id`) |
| Google shows `redirect_uri_mismatch` | The Authorized redirect URIs of the OAuth client must be exactly `<relay URL>/auth/google/callback`; a custom domain also needs its domain under Authorized domains (Branding) |
| Google says the app is only available to test users | The consent screen is still in Testing and this account is not among the Test users: add it, or Publish app |
| Cloudflare error 1027 | Today's Free plan requests are used up (see the table above) |

## OAuth apps for local development (GitHub / Google)

Production uses Google only (above). To try real OAuth in local development, create separate development apps (their
callback URLs differ):

- **GitHub** (an OAuth App, not a GitHub App): GitHub → Settings → Developer settings → OAuth Apps → **New OAuth
  App**. Homepage URL `http://localhost:8787`, Authorization callback URL (only one is allowed)
  `http://localhost:8787/auth/github/callback`; then copy the **Client ID** and press **Generate a new client
  secret**. The relay asks for no scope (it only reads the public id, login, name and avatar) and uses PKCE (S256).
- **Google**: as in [Google OAuth client](#google-oauth-client), with the JavaScript origin `http://localhost:8787`
  and the redirect URI `http://localhost:8787/auth/google/callback`.
- Put them into `apps/relay/.dev.vars` (see `.dev.vars.example`; the client IDs can live there too). Never put a
  production secret there.

## Build, deploy and test

```sh
pnpm --filter @smurg/relay typecheck   # wrangler types --check + tsc (once for the Worker, once for the Node tests)
pnpm --filter @smurg/relay test        # vitest, on a real local workerd
pnpm --filter @smurg/relay build       # wrangler deploy --dry-run (deploys nothing)
scripts/deploy-relay.sh                # a real deploy (needs a Cloudflare account, see "Deploying to Cloudflare"; no automated flow or test runs it)
```

After a change to the structure of `wrangler.jsonc` (a var or binding added or removed), run
`pnpm --filter @smurg/relay types` to regenerate `worker-configuration.d.ts`; a changed value (for example the URL
the deploy script writes) needs nothing: the types are generated with `--strict-vars=false` and do not depend on
values.

`build` first runs `scripts/check-web-dist.ts`: it refuses to bundle when `apps/web/dist` is missing or is only the
stand-in page that `pnpm dev:relay` and the tests put there (marked by `.smurg-stand-in`); run
`pnpm --filter @smurg/web build` first (or simply `pnpm build`). A real deploy needs the web build too
(`scripts/deploy-relay.sh` makes it). The build must also have a `_headers` whose `/*` rule has a
Content-Security-Policy with `frame-ancestors 'none'` and `Strict-Transport-Security: max-age=31536000` or longer
(both lines under the `/*` rule: under another rule, such as `/assets/*`, they do not count; no `includeSubDomains`
or `preload`, as in `apps/site`: that is a convention, the check only asks for a `max-age` of at least a year), and
when there is a `.vite/`, `.assetsignore` must list `.vite` (the build manifest is not served). Both files come from
`apps/web/public/`.

The tests name the language of every page they read (an explicit `Accept-Language`, or the browser's `locale`):
English by default, and `test/pages.test.ts` reads every page in both languages and compares it with the catalog.
They keep miniflare's temporary data in a `TMPDIR` of the run (`test/test-tmp.ts`), which the global teardown removes
when all tests are done.

## Using the relay in other packages' tests: `@smurg/relay/testing`

```ts
import { wsClientUrl, wsHostUrl } from '@smurg/protocol/relay';
import { connectRelaySocket, startLocalRelay } from '@smurg/relay/testing';

const relay = await startLocalRelay({ tap: true });          // 127.0.0.1, a random port, a fresh signing key each time
const alice = await relay.devLogin('alice', { displayName: 'Alice' });
const workspaceId = await relay.createWorkspace(alice.token);
const host = connectRelaySocket(wsHostUrl(relay.origin, workspaceId), { token: alice.token });
await host.opened;
// …the daemon and the clients use relay.origin; relay.identityToken(token, workspaceId, cnf) when needed
// relay.tap?.frames() is every byte the relay saw; findPlaintext(frames, marker) searches it for plaintext
await relay.stop();
```

- Fully isolated: every var and secret is passed explicitly (`.dev.vars` and the process environment are both
  overridden), and there is no OAuth provider by default.
- `relay.evictDurableObjects()` forces hibernation (sockets stay connected, memory state is gone);
  `relay.inspect(kind, id)` reads the state of a room.
- `connectRelaySocket` sends `"ping"` every 2 seconds by default; a test client that sends none is closed after
  `CLIENT_SWEEP_MS`.
- The R3 tap (`RELAY_TAP_URL`) only posts to a collector on this machine. It records every request the Worker sees
  (request line and headers) and every frame the two Durable Objects receive and send. A `"ping"` answered by the
  auto-response never reaches the relay's code, so it is not in the record.
- A test that reads one of the relay's HTML pages sends an explicit `Accept-Language` (or sets the `smurg_lang`
  cookie); the page's `data-state` says which page it is in either language.
