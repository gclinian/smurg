# Research: end-to-end encrypted channel (Noise) for browser + Node

Scope: SPEC R3 (whole section), section 0 ("do not implement cryptographic primitives yourself"), 7.2.
Spike (runnable): `/private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/noise`.
Appendix A contains the complete `src/` of the spike verbatim, in case the scratchpad goes away.
Date of the research: 2026-09-27. Machine: macOS arm64, Node v25.4.0 and v22.22.1, headless Chromium 145.

> **Independently verified on 2026-09-27** (spike re-run from a fresh install in `…/scratchpad/spikes/noise-verify`, plus 21 new tests (adversarial and corrected-design) and Chrome 153 / WebKit 26.6 / Firefox 155 runs). The core recommendation holds: build our own Noise state machine on `@noble/*`, with XXpsk3 for first contact and pinned XX for reconnect. Four things were wrong and are corrected inline, each marked **[Corrected]**. Details are in **## Verification** at the end.
> 1. **Device key storage fails in WebKit (Safari's engine).** WebKit cannot store or transfer an X25519 `CryptoKey`: IndexedDB returns `null`, `postMessage` fires `messageerror`, and `structuredClone` throws. The fix is a per-engine design (1.6).
> 2. **"Non-extractable" does not protect keys at rest.** Chromium and Firefox write the raw key bytes into the IndexedDB files on disk. Non-extractable only stops script from *exporting* the key.
> 3. **The `DaemonPolicy` seam has two security bugs.**
>    - Two concurrent joins can both use a 1-use invite.
>    - Before authentication, anyone who knows a device *public* key learns from the cleartext ABORT code whether that device is unknown, registered or revoked.
>
>    The fix is `admit()` plus encrypted verdicts (1.3, 1.4; code in Verification V-C).
> 4. **A lost WELCOME locks out a joiner who already consumed the invite.** The fix is to persist the daemon pin at msg2 (1.3).

---

## 1. Recommendation

### 1.1 Library: our own Noise state machine on audited `@noble/*` primitives

No npm Noise library fits the brief. The brief was `Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s`, running in Node >= 22 and in a Vite-bundled browser, with no native addon and a DH that can be async (for a non-extractable WebCrypto key). The evaluation is in 1.7.

**Decision:** we implement only the Noise *state machine*: CipherState, SymmetricState and HandshakeState, following Noise rev 34 sections 5, 7 and 9. It is `src/noise.ts`, about 400 lines including comments. It runs on these primitives:

| Primitive | Source |
|---|---|
| X25519 | `@noble/curves@2.4.0` (`x25519`), or WebCrypto `X25519` for the browser device key |
| ChaCha20-Poly1305 | `@noble/ciphers@2.4.0` (`chacha20poly1305`). The daemon may swap in `node:crypto` `chacha20-poly1305` (OpenSSL). It was cross-checked to produce byte-identical ciphertext. |
| BLAKE2s, HMAC, HKDF | `@noble/hashes@2.4.0` (`blake2s`, `hkdf`, which uses HMAC inside) |

We write no primitive ourselves. The only "crypto" code we own is the Noise token/transcript logic. The test vectors check exactly that logic:

- **1352 / 1352** published vectors pass: cacophony 944 + snow 408, all patterns, psk modifiers and suites. This holds on Node 25.4.0 and Node 22.22.1.
- **110 / 110** `25519_ChaChaPoly_BLAKE2s` vectors pass inside Chromium 145, from the Vite production bundle.
- The code interoperates on the wire with two independent implementations: salty-crypto (XXpsk3) and noise-c.wasm (XX).

**Honest trade-off.** We own about 400 lines of protocol logic, and a bug there is ours. What reduces the risk:

1. The full vector corpus is part of `pnpm test`.
2. The state machine is single-use and fails closed. Any error poisons it, a second call throws, and there are no concurrent calls.
3. Negative tests cover every attack in R3.
4. The code is small enough to review line by line against the spec.

**Runner-up: salty-crypto.** It is the only library that passed the XXpsk3 vector. We rejected it for three reasons:

- It ships its own unaudited primitives (tweetnacl ports and a hand-written BLAKE2s).
- Its DH is synchronous over raw secret bytes, so a non-extractable WebCrypto key is impossible without forking it.
- It is an rc, has a single maintainer, and lives in a self-hosted git repo.

### 1.2 Handshake patterns

| Situation | Protocol name | Trust anchor |
|---|---|---|
| First contact (invite link) | `Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s` | Client: `fingerprint(rs) == k` from `#k=`. Daemon: PSK from `#s=` (psk3) plus the invite record's role, expiry and uses. |
| Reconnect (device registered) | `Noise_XX_25519_ChaChaPoly_BLAKE2s` | Mutual static-key pinning. The client pins the daemon key it learned at first contact. The daemon checks the device registry (registered and not revoked). |

**Why XX with pinning for reconnect, rather than IK or KK:**

- **KK** needs the daemon to know the client's static key *before* msg1. That means either a cleartext device id, which leaks a stable identifier to the relay (R3 says the relay may see only workspace id, connection id, sizes and times), or trial DH over every registered device. Rejected.
- **IK** reveals the client static key in msg1. That exposure has no forward secrecy against a later compromise of the daemon key, and the msg1 payload is replayable. It saves one round trip only for data the daemon pushes unprompted.
- **XX with pinning:**
  - It is the same code path as XXpsk3; only the psk token differs.
  - It hides the client identity with forward secrecy (the static key travels encrypted in msg3).
  - The client rejects a wrong daemon key at msg2, before revealing anything.
  - The daemon rejects an unknown or revoked device at msg3.
  - Client-initiated requests have the same latency as with IK, about 2 RTT to the first response.

### 1.3 Wire format: one WebSocket binary message = one frame

```
0x01 HELLO   c->d  [0x01][ver=1][mode: 1=invite 2=device][noise msg1]     (inviteId is NOT on the wire)
0x02 REPLY   d->c  [0x02][noise msg2]
0x03 FINISH  c->d  [0x03][noise msg3]  (payload = client hello, e.g. display name)
0x10 DATA    both  [0x10]{ [u16be len][noise transport msg] }+   record plaintext = [flags u8][body]; flags bit0 = FIN
0x7f ABORT   both  [0x7f][0x00]   (cleartext, unauthenticated; ONE generic code, sent only before authentication)  [Corrected]
```

- Sizes: XXpsk3 msg1 is 48 bytes, msg2 96 bytes, msg3 64 bytes plus payload. Plain XX msg1 is 32 bytes.
- **[Corrected]** The first DATA message from the daemon is an encrypted **verdict**:
  - `[0x00][welcome…]` means admitted.
  - `[0x01][reason]` means rejected: invite-expired, invite-exhausted, device-unknown, device-revoked or not-allowed.

  The client treats the channel as up only after it decrypts `0x00`. This is key confirmation: in XXpsk3 the client cannot otherwise know that its PSK was accepted.

  The spike originally sent reasons such as `device-revoked` as cleartext ABORT codes, decided on the not-yet-authenticated msg3 static key. That lets anyone who holds only a device *public* key tell unknown, registered and revoked devices apart (verified, test V2). It also leaks the reasons to the relay. The corrected rule: every pre-authentication failure produces the same bytes (`[0x7f,0x00]`). Every decision about a device or invite is made after msg3 authenticates, and travels encrypted.
- **[Corrected]** The client persists the verified daemon key (`onDaemonVerified` hook) right after msg2 and **before** sending msg3. Otherwise a WELCOME lost to a network drop or a hostile relay leaves the device registered and the 1-use invite consumed, while the client thinks it failed and has no pin to reconnect with (verified, test V3). With the early pin, a device-mode reconnect recovers.
- The client may pipeline its first requests right after FINISH. The daemon is already authenticated at msg2, so this is safe. Only the "joined" UI waits for the verdict.

### 1.4 Invite link fragment, invite lookup and prologue (Q7)

```
https://smurg.app/join/<workspaceId>#k=<43 chars>&s=<43 chars>          (~128 chars total for a 14-char workspaceId)
k        = base64url_nopad( BLAKE2s-256( "smurg/v1 daemon static key fingerprint" || daemonStaticPub ) )   32 B
s        = base64url_nopad( 32 random bytes )                                                           32 B
inviteId = BLAKE2s( key = s, msg = "smurg/v1 invite id",  dkLen = 16 )    never sent; goes into the prologue
psk      = BLAKE2s( key = s, msg = "smurg/v1 invite psk", dkLen = 32 )    Noise psk3
prologue = "smurg-noise/1" || 0x00 || u8 len(workspaceId) || workspaceId || u8 mode || (inviteId if mode = invite)
```

- **Parsing.** The fragment parser is strict: exactly `k` and `s`, canonical base64url, 32 bytes each. Right after parsing, the web app calls `history.replaceState` to remove the fragment from the URL bar and from history (verified in Chromium).
- **How the daemon finds the invite.** In a psk handshake the `e` token also runs `MixKey(e)`. So msg1 carries a 16-byte AEAD tag whose AD is `h`, and `h` covers the prologue, which contains the inviteId. The daemon tries each invite on file (active, plus recently expired or used up so it can give a precise error). The one whose prologue makes msg1 verify is the invite. This needs no DH, and there is a 2^-128 chance of a false match.
  - The relay never sees the inviteId, so it cannot correlate joins to invites.
  - Only a holder of `s` can make msg1 verify, so random or forged HELLOs are rejected before the daemon spends any DH.
  - Measured cost: a full invite handshake with 50 invites on file, with the match last, takes 10.1 ms.
- **What the daemon stores.** Per invite: `{inviteId, psk, role, expiresAt, usesLeft}`. `s` itself is not needed.
- **Consuming a use.** `usesLeft` drops only after msg3 is authenticated, which proves the PSK. A failed attempt does not burn a use.
  - **[Corrected]** The check and the decrement must be **one synchronous step after authentication**: `policy.admit()` in the corrected `channel-v2.ts`, with no `await` inside.
  - The spike checked status at msg1 and decremented later in `onAccepted`, which could not reject. Two concurrent joins with a 1-use link then **both** succeed and register two devices (`usesLeft = -1`, verified in test V1).
  - Expiry is also re-checked at admission. The spike checked it only at msg1, so an invite that expired mid-handshake was still accepted (test V8).
  - If the invite store becomes async (for example a database), use a transaction.
- **Revoked devices.** A revoked device key is refused even through a fresh invite. A re-invited user must generate a new device key.

### 1.5 Transport framing for payloads up to 8 MiB (Q5)

- **Records.** A Noise transport message is at most 65535 bytes. So a record body is at most 65535 - 16 (tag) - 1 (flags) = **65518 bytes**.
- **One WS message per app message.** An 8 MiB app message becomes 129 records in a single WS message of 8,391,060 bytes (+2,452 bytes, 0.03 %). That is far under the relay's 32 MiB limit. A small message costs 20 bytes of overhead.
- **Boundaries are authenticated.** The FIN flag is *inside* the ciphertext. A relay that re-splits or merges WS messages cannot change where app messages begin and end.
  - A dropped, reordered or modified record breaks the nonce sequence and fails AEAD. The failure is fatal and the channel is poisoned.
  - The receiver caps reassembly (default 9 MiB) as a memory-DoS guard.
- **Measured throughput** for 8 MiB, seal and open measured separately:

  | Where | Seal | Open |
  |---|---|---|
  | Node 25, noble | 36.6 ms (219 MiB/s) | 35.8 ms (223 MiB/s) |
  | Node 22, noble | 39.1 ms (205 MiB/s) | 39.1 ms (205 MiB/s) |
  | Node 25, `node:crypto` | 6.0 ms (1336 MiB/s) | 5.1 ms (1561 MiB/s) |
  | Chromium 145, noble | 36.7–39.6 ms (~200–218 MiB/s) | 37.0–41.4 ms (~193–216 MiB/s) |
  | Chrome 153, noble (verifier) | 36.5 ms (219 MiB/s) | 36.6 ms (219 MiB/s) |
  | WebKit 26.6, noble (verifier) | 38.6 ms (207 MiB/s) | 39.6 ms (202 MiB/s) |
  | **Firefox 155, noble (verifier)** | **60.6 ms (132 MiB/s)** | **59.2 ms (135 MiB/s)** |

  An 8 MiB round trip from a Worker (seal, Node relay, daemon open and re-seal, open) took 418–674 ms in all three engines. That includes the noble daemon and the Node `ws` relay.

- **Recommendation:**
  - **Daemon:** use the `node:crypto` AEAD through the `Suite` interface. It is about 6x less CPU, and a test pins it byte-for-byte to noble.
  - **Browser:** use noble. WebCrypto has no ChaCha20-Poly1305. Run the file-transfer connection in a Web Worker.
  - **One Noise session per WebSocket.** The transfer Durable Object (DO) is a separate WebSocket, so it gets its own Noise handshake, using the same device key. Never share a CipherState across connections.

### 1.6 Device key storage (Q6)

**[Corrected]** The original design stored the non-extractable `CryptoKeyPair` object in IndexedDB on every engine. That **does not work in WebKit (Safari's engine)**. WebKit 26.6 cannot structured-clone an X25519 `CryptoKey`, private or public:

- `structuredClone` throws `TypeError`.
- IndexedDB `put` succeeds, but `get` returns `null`, even on the same page.
- `postMessage` to a Worker fires `messageerror`.

ECDH P-256, Ed25519 and AES keys clone fine, so the bug is specific to X25519. With the original code, a Safari user loses the device key on every reload and would need a new invite each time. The spike's `createDeviceKeyRecord` self-test does not catch this.

The corrected design is `src/device-key-v2.ts` in the verify spike, verbatim in Verification V-C. It picks one of three record kinds per engine:

| Record kind | When | What is stored in IndexedDB | Same-origin (XSS) script can… | At rest on disk (measured) |
|---|---|---|---|---|
| `webcrypto` | `structuredClone(pair)` works (Chrome 153, Firefox 155, Node) | Non-extractable X25519 `CryptoKeyPair` object | Use it, but not export it | **Raw key bytes in cleartext** in the IDB files (Chrome LevelDB `.log`, Firefox `.sqlite`) |
| `wrapped` | X25519 works but cannot be cloned (WebKit 26.6) | Non-extractable AES-GCM kek (`CryptoKey`), plus `wrapKey('pkcs8')` ciphertext, iv and public key. Each load calls `unwrapKey(…, extractable=false)`, which gives a non-extractable X25519 key; the raw scalar never becomes a JS array. | Call `unwrapKey(…, extractable=true)` and **export it** (verified) | Kek bytes not found on disk (WebKit wraps stored CryptoKeys) |
| `raw` | No WebCrypto X25519 | noble secret bytes | Read it | Cleartext |

This design was verified end to end in Chrome 153, WebKit 26.6 and Firefox 155. Each engine ran these phases:

- Create the key and read it back.
- Invite join over a real WebSocket.
- Reload, then reconnect from IndexedDB.
- Run the handshake plus an 8 MiB echo **inside a Worker** that opens IndexedDB itself.
- Relay MITM, which gives `daemon-key-mismatch` at msg2.
- Revoke, which gives a rejection at msg3.

In every engine `exportKey('pkcs8')` on the key in use was rejected with `InvalidAccessError`.

- **What "non-extractable" buys** (corrects the earlier sentence "it stops copying the key off the device (dumps, backups)"). It only stops *script* from exporting the key. It gives **no at-rest protection** in Chromium or Firefox, where malware or a backup that can read the browser profile gets the key. In both the `webcrypto` and `wrapped` modes, same-origin script can still *use* the key while the page is open. That residual risk is the SPEC R3 "known limitation".
- **Low-order points** are rejected with `OperationError` in Chromium, WebKit and Node, and with `DataError` in Firefox. Map any error to `handshake-failed`.
- **Real Safari 26.5** (installed here) was **not** run, because driving it needs a system setting we must not change. WebKit 26.6 is newer and shares the WebCore serialization code, so treat Safari as affected. Either way, the `structuredClone` probe picks the working path at runtime.
- **CLI:** raw 32-byte X25519 secret in the user's home, mode 0600 (per spec).
  - Verified under a fake HOME: `mkdirSync(dir, {recursive:true, mode:0o700})` plus `writeFileSync(f, key, {mode:0o600, flag:'wx'})` gives 0700 dirs and a 0600 file under umask 022, 077 and 000.
  - **Pitfall:** `writeFileSync(existingFile, …, {mode:0o600})` leaves an existing 0644 file at 0644, because mode applies only on creation. Write a temp file (`open(tmp,'wx',0o600)` plus `fchmod`), then `rename` it over the old one.
  - On load, refuse the key if `(mode & 0o077) !== 0`.
- **Daemon:** static key per workspace under `~/.smurg/...`, mode 0600. Never rotate it silently: clients will (correctly) refuse the new key with `daemon-key-mismatch`. The daemon itself was not built, but the verifier checked the file pattern above under a fake HOME.

### 1.7 Library evaluation (Q1)

| Candidate | Version (published) | XXpsk3 + BLAKE2s? | Browser + Node, no native addon? | Async / pluggable DH? | Verdict and evidence |
|---|---|---|---|---|---|
| noise-handshake (holepunch) | 4.2.0 (2025-12-01) | **No.** Only psk0; hash hard-wired to BLAKE2b (`HASHLEN=64`) | **No.** `sodium-universal` loads `sodium-native` (.node prebuilds) in Node | Curve module is pluggable but sync | `new Noise('XXpsk3',…)` throws; sodium-native in require graph |
| noise-protocol (emilbayes) | 3.0.2 (2023-01-12) | **No** psk at all; BLAKE2b | No (sodium-universal) | No | `initialize('XXpsk3')` throws "Unsupported handshake pattern" |
| noise-c.wasm | 0.4.0 (2018-10-07) | **No.** Only the obsolete rev-30 `NoisePSK_` naming | Yes (wasm) | No; manual `free()` | `Noise_XXpsk3_…` gives `NOISE_ERROR_UNKNOWN_NAME`. Loading it in Node installs process-wide `uncaughtException` and `unhandledRejection` handlers (the latter calls `process.exit(1)`). XX interop with ours OK. |
| @libp2p/noise (was @chainsafe/libp2p-noise) | 17.0.3 (2026-09-23) | **No.** Hard-coded `Noise_XX_25519_ChaChaPoly_SHA256`, libp2p identity payload | Yes | n/a | Source grep of `performHandshake.js`. Note that it also implements its own state machine on @noble. |
| libsodium-wrappers | 0.8.4 (libsodium 1.0.22) | **No** Noise and **no BLAKE2s** (`crypto_generichash` = BLAKE2b) | Yes (wasm/asm.js, async `ready`) | n/a | No `blake2s` symbol; 149.2 KiB gzip bundle |
| salty-crypto | 1.0.0-rc.4 (2025-12-30) | **Yes** (passes the cacophony XXpsk3 vector; interop with ours) | Yes, pure TS | **No.** Sync `dh(kp, pk)` over raw secret | Own unaudited primitives; rc; single maintainer. 10.2 KiB gzip. Runner-up. |
| @lukeburns/clatterjs | 1.0.0 (2026-04-24, only release) | **Yes.** [Corrected] The verifier ran `NqHandshake(noiseXxPsk3(), chachaPoly, blake2sH)` on the cacophony XXpsk3 vector: all 3 messages and the handshake hash match. | Yes (@noble) | **No.** `mapDh` calls sync `x25519Dh(this.s.secretKey, …)`; there is no `async` anywhere in `nqHandshake.js`. | Second runner-up. Single release, "restricted" publishConfig, a PQ-focused port. Needs raw secret bytes, so it cannot use a non-extractable device key. |
| Also checked by the verifier: `@brashkie/signalis-noise` 0.1.0, `noise-peer` / `simple-handshake`, `@node-dlc/noise`, `@harrier_/noise-js` | various | **No.** SHA-256 XX/IK/NK only (signalis, 0.1.0 from 2026-07), wrappers over noise-protocol plus sodium-native, BOLT-8 fixed suite, niomon fork | – | – | `npm search` plus `npm view` readme and dependencies. None changes the verdict. |
| @niomon/noise-js | 2.0.1 (2022) | **No.** Only `25519_AESGCM_SHA256` | Yes (tweetnacl) | No | README and source grep |
| **Ours (noble 2.4.0)** | spike | **Yes.** 1352/1352 vectors | Yes. Node 22/25 plus Vite bundle in Chromium | **Yes** (async `dh`) | **22.9 KiB gzip** (72.6 KiB min) for the client pieces, noble included |

Audits (from the installed READMEs):

- **@noble/curves:** Trail of Bits at 2.3.0 (Aug 2026, scope: everything); Cure53 at 1.6.0; Kudelski; Trail of Bits at 0.7.3.
- **@noble/ciphers:** Cure53 at 1.0.0 (Sep 2024, everything).
- **@noble/hashes:** Cure53 at 1.0.0 (Jan 2022, everything except blake3, sha3-addons, sha1 and argon2, so BLAKE2s and HMAC/HKDF are in scope).

We use 2.4.0, which has changed since those audits (the READMEs link the diffs).

**Scope note (verifier, from the same READMEs).** X25519 lives in noble's `montgomery` module. Only two of the curves audits cover it:

- Cure53 at 1.6.0 lists "montgomery" in scope.
- Trail of Bits at 2.3.0 covered "everything".

The Kudelski audit (starknet and weierstrass) and the Trail of Bits 0.7.3 audit (weierstrass and secp256k1) do not cover X25519. Both the ciphers and hashes READMEs now also mention "AI-assisted self-audits" since April 2026. Those are not independent audits.

---

## 2. Dependencies (exact versions installed and run)

| Package | Version | Used by | Note |
|---|---|---|---|
| `@noble/curves` | 2.4.0 | protocol (web, cli, daemon) | X25519; v2 needs `.js` subpaths, e.g. `@noble/curves/ed25519.js` |
| `@noble/ciphers` | 2.4.0 | protocol | `chacha20poly1305` from `@noble/ciphers/chacha.js` |
| `@noble/hashes` | 2.4.0 | protocol | `blake2s` from `@noble/hashes/blake2.js`, `hkdf` from `@noble/hashes/hkdf.js` |
| `vite` | 8.3.1 | web (dev) | Bundled the page with no config beyond `root`; no polyfills, no wasm |
| `typescript` | 7.0.2 | all (dev) | `tsc -p .` clean with `allowImportingTsExtensions` and `erasableSyntaxOnly` |
| `@types/node` | 26.6.3 | dev | |
| `ws` | 8.22.0 (+ `@types/ws` 8.18.1) | spike demo only | Stood in for the relay. The real relay is CF Workers; the daemon can use Node's global `WebSocket` client. |
| `playwright` | 1.63.0 | verification only | Drove Chrome 153 (system), plus WebKit 26.6 and Firefox 155 downloaded into the verify spike dir (`PLAYWRIGHT_BROWSERS_PATH`) |
| Evaluated only | noise-handshake 4.2.0 (+ sodium-universal 5.0.1, sodium-native 5.1.0), noise-protocol 3.0.2, noise-c.wasm 0.4.0, @libp2p/noise 17.0.3, libsodium-wrappers 0.8.4 (libsodium 0.8.4 / 1.0.22), salty-crypto 1.0.0-rc.4, @lukeburns/clatterjs 1.0.0, @niomon/noise-js 2.0.1 | none | Installed in `eval/` |

Test vectors: `cacophony.txt` from `haskell-cryptography/cacophony@master/vectors/` (944 vectors) and `snow.txt` from `mcginty/snow@main/tests/vectors/` (408 vectors). Both were downloaded 2026-09-27 into `vectors/`.

---

## 3. Verified facts

All commands run from the spike directory (`SPIKE=…/scratchpad/spikes/noise`).

| # | Claim | Evidence |
|---|---|---|
| F1 | The state machine reproduces every published vector byte for byte (handshake ciphertexts, transport ciphertexts, handshake hash). | `node test/vectors.run.ts` gives `cacophony.txt: total=944 pass=944 skip=0 fail=0` and `snow.txt: total=408 pass=408 skip=0 fail=0`. It explicitly passes `Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s` (cacophony), `Noise_XX/IK/KK_25519_ChaChaPoly_BLAKE2s` (both files) and `Noise_XXpsk0+psk3_…` (snow). |
| F2 | The vector check is sensitive. | Negative control in the same run: a tampered PSK on both sides gives `fail (handshake_hash)`. |
| F3 | Works on Node 22 too. | `~/.nvm/versions/node/v22.22.1/bin/node test/vectors.run.ts` gives the same 944/408 passes. `node --test test/*.test.ts` passes 23/23 on both 25.4.0 and 22.22.1. Node runs the `.ts` files directly (type stripping). |
| F4 | Works in the browser from a Vite production bundle. | `npx vite build` then `bash demo/browser-e2e.sh` gives Chromium 145 `"vectors":{"pass":110,"fail":0,…,"xxpsk3":true}`. |
| F5 | Interop with independent implementations. | `node eval/eval-libs.ts`: salty-crypto reproduces the cacophony XXpsk3 messages (`match: true`); salty initiator with our responder completes, and transport works both ways. noise-c.wasm initiator with our responder completes plain XX (`XX interop msg3 payload: XX from noise-c`). |
| F6 | noise-handshake cannot do XXpsk3/BLAKE2s and pulls a native addon. | `eval-libs.ts`: `XXpsk3 -> throws`, `HASHLEN=64`, `sodium-native … in require graph: true`. `ls eval/node_modules/sodium-native/prebuilds` shows `.node` binaries. |
| F7 | noise-protocol has no psk. | `initialize('XXpsk3') -> throws: Unsupported handshake pattern; hash=BLAKE2b` |
| F8 | noise-c.wasm lacks psk modifiers and hijacks process handlers. | `names: {"Noise_XXpsk3_…":"NOISE_ERROR_UNKNOWN_NAME","NoisePSK_XX_…":"ok"}`; `unhandledRejection=1 uncaughtException=1` listeners after load. |
| F9 | libsodium-wrappers has no BLAKE2s and no Noise. | `blake2s fns: []; noise fns: []; generichash = BLAKE2b (BYTES_MAX=64)` |
| F10 | @libp2p/noise is fixed to a SHA256 XX suite. | `grep protocolName eval/node_modules/@libp2p/noise/dist/src/performHandshake.js` shows `'Noise_XX_25519_ChaChaPoly_SHA256'` twice. |
| F11 | First contact with a **non-extractable WebCrypto** device key works, and the relay sees no plaintext. The relay log contains no app text, file marker, psk, s, inviteId, device static public key or msg3 hello. | Test `first contact XXpsk3 with non-extractable WebCrypto device key…` (Node WebCrypto). Browser run: `"wsInvite":{"ok":true,…},"relayReport":{"frames":10,"bytes":533,"markerHits":[]}` over a real WebSocket to a Node relay. |
| F12 | (4a) Wrong PSK: the **daemon** rejects at **msg3**. The psk3 token is mixed in msg3 and the first AEAD under the PSK-dependent key is the msg3 payload tag. The invite is not consumed and nothing is registered. | Test `4a right inviteId but wrong PSK…`: `dm.code=handshake-failed, atMessage=3, message=/msg3 rejected: decrypt/`; client gets `aborted:handshake-failed`; `usesLeft` stays 1. |
| F13 | (4a') No valid fragment at all: rejected at **msg1**, before any DH. | Test `4a' …`: `invite-unknown` at msg1; relay sees `[0x7f, 1]`. |
| F14 | (4b) Relay substitutes its own static key on first contact: the client aborts at **msg2** and never sends msg3. If the relay somehow knows the inviteId, the transcript hashes agree and **only the `k` fingerprint check** catches it (`daemon-key-mismatch`). If it doesn't, the AEAD over the encrypted static key fails first (`handshake-failed`). | Two tests `4b relay substitutes its own static key (first contact, relay somehow knows / does not know inviteId)`. The MITM forges a msg1 that verifies under its own prologue guess. With the right inviteId the forgery is byte-identical to the real msg1 (asserted). |
| F15 | (4b') Same on reconnect with the pinned key. | Test `4b'` plus browser phase `mitm`: `"reconnect":{"ok":false,"code":"daemon-key-mismatch","atMessage":2}`. |
| F16 | Tampering with the encrypted daemon static key in msg2 fails AEAD at msg2. | Test `4b''`. |
| F17 | (4c) A revoked device key cannot reconnect, and cannot come back through a fresh invite. An unknown key cannot reconnect. Rejected at **msg3**, right after the client static key is decrypted. **[Corrected]** Deciding on the *unauthenticated* key and sending the reason in cleartext is a status oracle. Test V2 shows that someone holding only a public key gets `device-unknown`, `device-revoked` or `handshake-failed` for an unknown, revoked or registered device. `channel-v2.ts` decides only after authentication and encrypts the verdict. | Test `4c …`: `device-revoked` at msg3, `device-unknown` at msg3. Browser phase 3 after `POST /demo/revoke`: `"code":"aborted:device-revoked","atMessage":3`. |
| F18 | Reconnect with XX (no PSK) and pinned keys works from a key read back from IndexedDB after navigation. **[Corrected]** This holds in Chromium and Firefox only. In WebKit 26.6 the stored X25519 `CryptoKeyPair` reads back as `null` ("nothing stored in IndexedDB"), so reconnect is impossible. The fix is in 1.6. | Browser phase 2: `"fromIndexedDB":{"privateExtractable":false,"privateType":"private","algorithm":"X25519"},"reconnect":{"ok":true,…}` |
| F19 | Expired or used-up invites are rejected at msg1 with a precise reason. **[Corrected]** This holds only for *sequential* attempts. Two concurrent joins on a 1-use invite both succeed (test V1), and an invite that expires between msg1 and msg3 is still accepted (test V8). With `channel-v2.ts`'s atomic `admit()`, exactly one join succeeds and the other gets an authenticated `invite-exhausted`. | Test `invite limits…`: `aborted:invite-exhausted`, `aborted:invite-expired`. |
| F20 | HELLO tampering (1 byte of msg1) makes every invite fail, so `invite-unknown` at msg1. A mode-byte flip or a different workspaceId fails the handshake (client AEAD at msg2). | Tests `relay flips one byte of msg1…`, `relay flips the mode byte…`, `workspace binding…` |
| F21 | XXpsk3 msg1 is 48 bytes (e + 16-byte tag) because a psk-mode `e` does `MixKey(e)`. Plain XX msg1 is 32 bytes. HELLO frame = 51 bytes. | Test asserts `all[0].length === 3 + 32 + 16`. Browser byte count 533 = 51 + 97 + 77 + 34 + 274. |
| F22 | Invite trial matching is cheap. | `full invite handshake with 50 candidate invites (worst case): 10.1 ms` |
| F23 | Plain-XX msg1 is unauthenticated: 148 of 400 random HELLOs parked the daemon waiting for msg3, so **handshake deadlines are mandatory**. No input crashed the daemon; all others produced `ChannelError`. | Test `robustness: …` gives `{ rejected: 252, waitingForMsg3: 148, other: 0 }` |
| F24 | Framing: 8 MiB takes 129 records and one frame of `1 + 129*19 + 8 MiB` bytes, round trip OK. Re-split and merged WS messages still yield exactly the original app messages. A dropped record is fatal and the channel stays dead. A bit flip is fatal. The reassembly cap is enforced. | `node --test test/framing.test.ts` (6/6) |
| F25 | Throughput (8 MiB): noble ~205–223 MiB/s per direction in Node, ~193–218 MiB/s in Chromium. `node:crypto` 1336/1561 MiB/s. Native and noble ciphertexts are identical. | `node bench/throughput.ts` on Node 25 and 22. Browser `throughput8MiB` in phase 1. Line `native vs noble ciphertext identical: true`. |
| F26 | A full XXpsk3 handshake (both sides in one process, including two static keygens) takes ~6.3 ms in Node. With a WebCrypto async device key in Chromium it is 5.5–6.3 ms. | `bench/throughput.ts`; browser `localHandshake.ms` |
| F27 | WebCrypto X25519 in Chromium 145: non-extractable private key, `exportKey('pkcs8')` rejected with `InvalidAccessError`, DH identical to noble, all-zero public key rejected with `OperationError`, storable in IndexedDB. **[Corrected / extended]** The verifier saw the same in Chrome 153 and Firefox 155; Firefox rejects the low-order key with `DataError`. WebKit 26.6 matches on everything except storage: it is **not storable** (see F18). "Storable" does not mean protected: Chrome and Firefox keep the raw bytes on disk. | Browser phase 1 `webcrypto` block |
| F28 | A non-extractable X25519 `CryptoKey` can be posted to a Web Worker and used there (`deriveBits` gives the same secret as the main thread; the worker sees `extractable=false`). **[Corrected]** This holds in Chromium and Firefox. In WebKit 26.6 the worker gets `messageerror` for X25519 keys, private or public. Portable approach: the Worker opens IndexedDB itself and uses the corrected record, which was verified in all three engines. | `demo/worker-check.js` via `browse eval` gives `{"workerOk":true,"workerSeesExtractable":false,"sameSharedSecretAsMainThread":true}` |
| F29 | Falls back cleanly when WebCrypto lacks X25519. | `test/device-key.test.ts`, with `generateKey` rejecting `NotSupportedError`, gives `kind='raw'` and the handshake still succeeds. |
| F30 | Strict fragment parser: a missing key, an extra key or non-canonical base64url is rejected. The URL fragment is stripped after reading. (Verifier: missing, extra, duplicate, padded, `+` and short values are rejected. Percent-encoded characters such as `%4x` are accepted because `URLSearchParams` decodes them to the same bytes, which is harmless. The fragment was stripped in all three engines.) | Ad-hoc run (3 rejections printed); browser `"fragmentStripped":true` |
| F31 | noble `x25519.getSharedSecret` rejects low-order public keys (throws) instead of returning zeros. | `node_modules/@noble/curves/abstract/montgomery.d.ts`: "Rejects low-order public inputs instead of returning the all-zero shared secret" |
| F32 | Bundle cost (Vite 8 / Rolldown, minified): ours with noble 72.6 KiB / **22.9 KiB gzip**; salty-crypto 10.2 KiB gzip; libsodium-wrappers 149.2 KiB gzip; noise-c `.wasm` alone 84.1 KiB gzip. | `node bundle/measure.mjs` |
| F33 | The spike type-checks. | `npx tsc -p .` exit 0 (TypeScript 7.0.2) |

---

## 4. Unverified / could not test here

*(Updated by the verifier. Items that are now verified are struck out and point to the evidence.)*

- ~~**Firefox and Safari.**~~ **Firefox 155 and WebKit 26.6** (Playwright builds) are now verified. This found the WebKit X25519 clone failure, fixed in 1.6. **Still unverified:** the real Safari 26.5 app and a stock Firefox release. Safari automation needs "Allow Remote Automation", a system setting we must not change.
- **Cloudflare Workers / Durable Objects relay.** Not built here. Not verified: that it preserves per-connection message order, the 32 MiB limit, Hibernation API behaviour with binary frames, and real latency and throughput through CF. The relay stand-in was a Node `ws` server.
- ~~**Node SEA packaging**~~ **Verified.** A Vite SSR bundle (426 KB CJS, only `node:crypto` and `node:sea` external) was injected with postject into a copy of Node 25.4.0 and ad-hoc signed. It ran with `env -i`: `{"sea":true,"vectors":{"pass":110,"fail":0},…,"echo8MiB":true}`, with a noble client and a `node:crypto` daemon suite.
- ~~**The key files.**~~ **Verified under a fake HOME** inside the spike (see 1.6, CLI bullet). Found a pitfall: the mode is not applied to an existing file.
- ~~**Full transfer channel inside a Worker.**~~ **Verified** in Chrome 153, WebKit 26.6 and Firefox 155. The Worker opens IndexedDB, loads the device key, runs the XX handshake over its own WebSocket, and echoes 8 MiB (418–674 ms round trip).
- **Formal properties.** The Noise security-property claims used to pick XX over IK come from the Noise spec (sections 7.7 and 7.8), not from tests. The verifier did demonstrate IK msg1 replayability: test V9 shows a recorded IK msg1 payload accepted by a fresh responder.
- **Audits:** no audit found or claimed for noise-handshake, salty-crypto or clatterjs. The noble audit list comes from the installed READMEs; the reports themselves were not read. *Still unverified.*
- ~~**Nonce exhaustion.**~~ **Verified** (test V7). The guard fires at 2^53-1, and `chachaNonce` matches the spec's LE64 encoding for n = 0, 2^32-1, 2^32, 0x123456789abcd and 2^53-1.
- ~~**clatterjs** was inspected, not executed.~~ **Executed:** it passes the XXpsk3 vector, and its DH is sync over raw secrets (see 1.7).
- **Real-Safari at-rest behaviour.** WebKit did not leave the AES key bytes on disk. Not checked for the actual Safari app or for iOS.
- **Identity binding to the OAuth account.** Out of scope, but note: the relay does OAuth, so any "user X" claim that arrives via the relay is not end-to-end authenticated. The device key is the real identity. Put a relay-signed identity token in the msg3 payload and treat it as advisory. **To decide.**

---

## 5. Gotchas

1. **The `onRemoteStatic` hook runs BEFORE the key is authenticated.** In XX/XXpsk3 msg3 the static key is decrypted before `se`/`psk` are mixed. Only the final payload tag proves possession and the PSK.
   - **[Corrected]** Do **not** reject on the daemon side from this hook either. A pre-auth rejection with a distinguishable reason is a device-status oracle (test V2).
   - Decide everything in one synchronous `admit()` after `readMessage` resolves, and send the verdict encrypted (`channel-v2.ts`).
   - Client-side use of the hook (the msg2 fingerprint or pin check) is fine, because the client rejects only its own connection.
2. **The client must wait for the encrypted verdict (WELCOME)** before assuming the channel is up. In XXpsk3 the PSK is checked only by the daemon at msg3, so the client learns about PSK acceptance only from the daemon's first DATA frame.
   - **[Corrected]** Persist the daemon pin **at msg2** (`onDaemonVerified`), not after WELCOME. See test V3.
3. **Handshake deadline plus rate limit on the daemon.** A plain-XX msg1 is just 32 arbitrary bytes. Anyone who can reach the daemon through the relay can park a handshake at "waiting for msg3" (F23). Use about 10 s per handshake and a cap on concurrent pending handshakes.
4. **A psk-mode `e` makes msg1 authenticated (48 bytes).** That is what makes invite trial-matching possible. It also means the relay can tell first contact (48-byte msg1) from reconnect (32-byte msg1) by size. That is acceptable; the mode byte in HELLO says the same.
5. **Relay-visible metadata beyond R3's list:**
   - The 1-byte frame type (also derivable from sizes and order).
   - The mode byte.
   - ~~Cleartext ABORT reason codes (for example "device-revoked"). **Needs a product decision.**~~ **[Corrected] Decided by R3:**
     - Before authentication, send one generic ABORT.
     - After authentication, every reason (revoked, unknown device, expired or exhausted invite) goes in the encrypted verdict. The UX loses nothing, because the legitimate key owner still gets the exact reason.
     - The relay can still infer accept vs reject from what follows (connection closes, verdict size). Pad the verdict if that matters.
   - The daemon static public key is encrypted in msg2, but any client can learn it by starting a handshake (XX responders reveal `s` to active initiators). It is also the preimage of `k`.
6. **One Noise session per WebSocket.** Interactive and file-transfer connections go to different DOs, so each does its own handshake. Never share CipherStates, because nonces must stay strictly in order per direction.
7. **Any AEAD failure on a transport record is fatal.** Close the socket, re-handshake, and resend by app-level `seq`. After reconnect the keys are fresh and nonces restart at 0, so the app must dedupe by `seq`, not rely on Noise.
8. **Reassembly cap.** `Opener` caps reassembly (9 MiB default). Size it per connection type: interactive vs transfer, plus a large Yjs initial sync if that ever goes as one message.
9. **Low-order public keys are rejected** by noble (throws) and by WebCrypto: `OperationError` in Chromium, WebKit and Node, `DataError` in Firefox. Such handshakes fail. That is fine, but surface it as a generic `handshake-failed`. The verifier checked u = 0, 1, both order-8 points, p-1 and p in noble and in Node WebCrypto.
10. **WebCrypto has no ChaCha20-Poly1305 and no BLAKE2s.** Only X25519 can be native in the browser; symmetric crypto is noble JS. Measured: about 200–220 MiB/s in Chrome and WebKit, but **about 135 MiB/s in Firefox**. Use a Worker for bulk transfer so typing and the terminal stay smooth (R7 upload acceptance).
11. **The daemon's native AEAD** (`node:crypto` `chacha20-poly1305`).
    - **[Corrected]** `authTagLength: 16` and `setAAD(ad, { plaintextLength })` are *optional* for chacha20-poly1305. The tag defaults to 16 bytes, and output without options is identical to noble (test V6). Passing them is harmless.
    - **Verified** by the verifier: the `node:crypto` suite reproduces all **676/676** `*_ChaChaPoly_*` vectors through the state machine (test V5). Empty, short (0–16 byte) and tampered ciphertexts all fail closed.
    - Keep that vector test in CI for the daemon suite.
12. **noble v2 API changes:** subpath imports end in `.js`; `x25519.utils.randomSecretKey()` (not `randomPrivateKey`); `hkdf(hash, ikm, salt, info, len)`. A cipher instance is single-use per (key, nonce): create one per message.
13. **Constant time is best-effort.** noble targets algorithmic constant time; JS/JIT/GC give no guarantee (its README says so). Same for any JS crypto.
14. **Fragment hygiene.** Call `history.replaceState` right after parsing. Never log `location.href`. No third-party scripts on `/join/*`. Fragments are never sent to the server or in `Referer`.
15. **Do not load noise-c.wasm in the daemon.** Its Emscripten glue installs `process.on('unhandledRejection', () => process.exit(1))`.
16. **The pinned daemon key is per workspace** (client side, stored with the device key). If the host reinstalls and the daemon key changes, every client gets `daemon-key-mismatch`: show the SPEC-mandated warning and require a new invite. Never auto-accept a new key.
17. **TypeScript:** keep protocol code to *erasable* syntax (no enums, parameter properties or namespaces) and use `.ts` import suffixes with `allowImportingTsExtensions`. Then Node 22.18+ and Node 25 run the sources and tests directly, and Vite bundles them unchanged.
18. **Test markers must be long.** An earlier version of test F11 used a 3-byte marker ("Amy") and failed about 1 run in 15, because random ciphertext contained it by chance. Use markers of at least 16 bytes when asserting "relay never sees X".
19. **(Verifier) WebKit cannot structured-clone X25519 `CryptoKey`s.** `structuredClone` throws `TypeError`, IndexedDB returns `null`, and `postMessage` fires `messageerror`. Detect this with a `structuredClone(pair)` probe at key creation, and re-validate every record read from IndexedDB (`isUsableRecord`). See 1.6.
20. **(Verifier) Non-extractable is not encrypted at rest.** Chrome 153 and Firefox 155 store the raw private-key bytes in the profile's IndexedDB files. Do not describe the browser device key as protected against disk or backup theft.
21. **(Verifier) Invite admission must be atomic.** Check-and-consume in one synchronous step after msg3 authenticates, and re-check expiry there. Otherwise concurrent joins overrun `usesLeft` (V1) and expired invites slip through (V8).
22. **(Verifier) Replay, reflection and cross-session DATA frames are all fatal**, as intended (test V4). This follows from per-direction keys and strict nonces. Do not "helpfully" skip or re-order records on the app side.

---

## 6. Verified code (key snippets that ran)

State machine core (`src/noise.ts`, excerpt: token processing):

```ts
  async writeMessage(payload: Uint8Array = EMPTY): Promise<Uint8Array> {
    const tokens = this.enter(true); // turn check; throws if failed/complete/busy
    try {
      const parts: Uint8Array[] = [];
      for (const t of tokens) {
        if (t === 'e') {
          if (!this.e) this.e = this.suite.generateKeyPair();
          parts.push(this.e.publicKey);
          this.ss.mixHash(this.e.publicKey);
          if (this.isPsk) this.ss.mixKey(this.e.publicKey);
        } else if (t === 's') {
          if (!this.s) throw new NoiseError('bad-config', 'local static key required');
          parts.push(this.ss.encryptAndHash(this.s.publicKey));
        } else {
          await this.mixToken(t); // ee/es/se/ss -> mixKey(await keyPair.dh(remote)); psk -> mixKeyAndHash(psk)
        }
      }
      parts.push(this.ss.encryptAndHash(payload));
      const msg = concat(...parts);
      if (msg.length > MAX_MESSAGE_LEN) throw new NoiseError('too-large', 'handshake message exceeds 65535 bytes');
      this.finishMessage(); // Split() after the last pattern message
      return msg;
    } catch (err) {
      this.failed = true;
      throw err;
    } finally {
      this.busy = false;
    }
  }
```

Suite on noble, and the WebCrypto non-extractable adapter (`src/suite.ts`):

```ts
export const Noise_25519_ChaChaPoly_BLAKE2s: Suite = {
  name: '25519_ChaChaPoly_BLAKE2s', dhLen: 32, hashLen: 32,
  generateKeyPair: () => x25519KeyPair(),
  encrypt: (k, n, ad, pt) => chacha20poly1305(k, chachaNonce(n), ad).encrypt(pt),
  decrypt: (k, n, ad, ct) => chacha20poly1305(k, chachaNonce(n), ad).decrypt(ct),
  hash: (data) => blake2s(data),
  hkdf: (ck, ikm, outputs) => hkdfBlocks(blake2s, 32, ck, ikm, outputs), // hkdf(blake2s, ikm, salt=ck, info=empty, 32*n)
};

export async function webCryptoX25519KeyPair(pair: CryptoKeyPair, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<KeyPair> {
  const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey,
    async dh(remotePublic: Uint8Array): Promise<Uint8Array> {
      const remote = await subtle.importKey('raw', remotePublic as Uint8Array<ArrayBuffer>, { name: 'X25519' }, true, []);
      const bits = await subtle.deriveBits({ name: 'X25519', public: remote }, pair.privateKey, 256);
      return new Uint8Array(bits);
    },
  };
}
```

Daemon: trial-match the invite on msg1 (`src/channel.ts`):

```ts
for (const inv of o.policy.invites()) {           // active + recently expired/exhausted
  const cand = responder(o, mode, inv);             // XXpsk3, prologue incl. inv.inviteId, psks [inv.psk]
  try { await cand.readMessage(msg1); } catch { continue; }
  hs = cand; invite = inv; break;
}
if (!hs || !invite) throw new ChannelError('invite-unknown', 'no invite matches msg1', 1);
if (invite.status !== 'ok') throw new ChannelError(invite.status, 'invite no longer usable', 1);
```

Client: pin or check the fingerprint at msg2 (`src/channel.ts`):

```ts
await hs.readMessage(msg2, (rs) => {
  const ok = o.trust.kind === 'invite'
    ? equalBytes(daemonFingerprint(rs), o.trust.fingerprint)
    : equalBytes(rs, o.trust.daemonKey);
  if (!ok) throw new ChannelError('daemon-key-mismatch', 'daemon static key does not match the invite fingerprint / pinned key', 2);
});
```

Usage exactly as exercised in the browser and in the tests:

```ts
// browser, first contact
const pair = await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']) as CryptoKeyPair;
await idbPut('device', pair);                                    // CryptoKeyPair object, extractable stays false
const device = await webCryptoX25519KeyPair(pair);
const { k, s } = parseInviteFragment(location.hash);
history.replaceState(null, '', location.pathname + location.search);
const io = await wsIO(`ws://${location.host}/relay/client`);     // FrameIO { send(frame), recv(): Promise<frame> } over a browser WebSocket
const c = await clientConnect(io, { workspaceId, deviceKey: device, trust: { kind: 'invite', fingerprint: k, secret: s }, hello: utf8('browser-user') });
await idbPut('pinnedDaemonKey', toHex(c.daemonKey));
io.send(c.channel.seal(bytes));                                  // any size up to the peer cap
const msgs = c.channel.open(frame);                              // 0..n complete app messages

// later: reconnect
const c2 = await clientConnect(io2, { workspaceId, deviceKey: device, trust: { kind: 'pinned', daemonKey: fromHex(pinnedHex) } });

// daemon
const r = await daemonAccept(io, { workspaceId, staticKey, policy /* invites(), checkDevice(), onAccepted() */, welcome: ({ mode }) => utf8(`welcome mode=${mode}`) });
for (;;) for (const m of r.channel.open(await io.recv())) io.send(r.channel.seal(m));
```

---

## 7. How to re-run the spike

```bash
cd /private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/noise
npm install                       # root deps (noble, vite, ts, ws); eval/ has its own node_modules
node test/vectors.run.ts          # 944 + 408 vectors + negative control
node --test test/*.test.ts        # 23 tests (handshake / attacks / framing / device key)
~/.nvm/versions/node/v22.22.1/bin/node --test test/*.test.ts   # same on Node 22
node bench/throughput.ts          # 8 MiB seal/open, noble vs node:crypto, handshake cost
npx tsc -p .                      # type-check
node eval/eval-libs.ts            # library evaluation (needs: cd eval && npm install)
node bundle/measure.mjs           # bundle sizes
bash demo/browser-e2e.sh          # Vite build + Node relay/daemon + headless Chromium (gstack browse):
                                  # phase1 (vectors, WebCrypto, IndexedDB, throughput, WS invite),
                                  # phase2 (reconnect from IndexedDB), mitm, revoke + phase3; kills everything at exit
```

**Verifier's re-run:** `bash /private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/noise-verify/run-verify.sh`.

- It covers a fresh install, the vectors, 44 tests on Node 25 and 22, tsc, bench, the library evaluation plus clatterjs, key files, all Playwright probes in three engines, and the corrected-design end-to-end run. It kills the demo server on exit.
- WebKit and Firefox are kept in `noise-verify/pw/browsers`.
- The SEA check is `bash sea/build.sh`, which deletes its 127 MB binary afterwards.

Without gstack browse, run `node demo/server.ts 5178`. Open the URL printed by `curl http://127.0.0.1:5178/demo/invite` in any browser. Then open `/join/ws_demo?phase=2`, `?phase=mitm`, and `?phase=3` (after `curl -X POST '/demo/revoke?pub=<devicePub from phase 1>'`). Results appear in the page's `<pre>`.

Spike layout: `src/` (the adoptable module: `noise.ts`, `suite.ts`, `framing.ts`, `invite.ts`, `channel.ts`, `device-key.ts`, `bytes.ts`), `test/` (vectors runner, full pattern table, all-suites factory, harness with a tamper-capable in-memory relay, node:test suites), `bench/`, `eval/`, `bundle/`, `browser/` (Vite page), `demo/` (relay + daemon server, e2e script, worker check), `vectors/`.

**Suggested adoption into `packages/protocol`:**

- **[Corrected]** Copy these files into `packages/protocol/src/crypto/`:
  - From this spike: `bytes.ts`, `suite.ts`, `noise.ts`, `framing.ts`, `invite.ts`.
  - From the verify spike: **`channel-v2.ts`** in place of `channel.ts`'s client and daemon drivers. It re-exports `ChannelError`, `SecureChannel` and `FrameIO`, so it still imports `channel.ts` for those three.
  - From the verify spike: **`device-key-v2.ts`** in place of `device-key.ts`.
  - Both files are verbatim in Verification V-C.
- Move `test/patterns-all.ts`, `test/suites-all.ts`, `test/vectors-core.ts` and the two vector files into the protocol package tests, and keep the full corpus in CI.
- `DaemonPolicy` is the seam to the daemon's invite store, device registry and audit log (R2, R11).
- Add handshake deadlines, rate limits, and the `node:crypto` Suite on the daemon.

---

## Appendix A: complete module sketch (verbatim from spike `src/`, all of it ran under the tests above)

> **[Corrected]** The verifier confirmed that Appendix A is byte-identical to the spike's `src/` and `test/` files. Two parts are **superseded**:
> - The `clientConnect`/`daemonAccept`/`DaemonPolicy` part of `channel.ts`, because of the invite race, the pre-auth oracle and cleartext reasons.
> - All of `device-key.ts`, because it fails in WebKit.
>
> Use the corrected `channel-v2.ts` and `device-key-v2.ts` in Verification V-C. `bytes.ts`, `suite.ts`, `noise.ts`, `framing.ts` and `invite.ts` stand as they are.


### `src/bytes.ts`

```ts
// Small byte helpers shared by Node and browser. No crypto here.

export const EMPTY = new Uint8Array(0);

export function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Constant-time (w.r.t. content) equality for equal-length arrays. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('odd hex length');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error('bad hex');
    out[i] = byte;
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** RFC 4648 section 5 base64url, no padding. */
export function toBase64Url(b: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63];
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i] << 16;
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63];
  }
  return out;
}

/** Strict base64url (no padding, canonical trailing bits) decoder. */
export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new Error('invalid base64url');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let o = 0;
  for (const ch of s) {
    acc = (acc << 6) | B64URL.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if ((acc & ((1 << bits) - 1)) !== 0) throw new Error('non-canonical base64url');
  return out;
}
```

### `src/suite.ts`

```ts
// Cipher-suite plumbing for the Noise state machine.
// ALL primitives come from audited libraries (@noble/*) or the platform (WebCrypto).
// Nothing in this file implements a primitive; it only adapts signatures.

import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { blake2s } from '@noble/hashes/blake2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

/**
 * A DH key pair whose private half may live anywhere (raw bytes, WebCrypto
 * non-extractable CryptoKey, OS keychain...). The state machine only ever calls dh().
 */
export interface KeyPair {
  readonly publicKey: Uint8Array;
  dh(remotePublic: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

export interface Suite {
  /** e.g. "25519_ChaChaPoly_BLAKE2s" (goes into the protocol name). */
  readonly name: string;
  readonly dhLen: number;
  readonly hashLen: number;
  generateKeyPair(): KeyPair;
  encrypt(k: Uint8Array, n: number, ad: Uint8Array, plaintext: Uint8Array): Uint8Array;
  /** Must throw on authentication failure. */
  decrypt(k: Uint8Array, n: number, ad: Uint8Array, ciphertext: Uint8Array): Uint8Array;
  hash(data: Uint8Array): Uint8Array;
  /** Noise HKDF (== RFC 5869 with salt = ck, empty info). Returns `outputs` HASHLEN-sized blocks. */
  hkdf(ck: Uint8Array, ikm: Uint8Array, outputs: 2 | 3): Uint8Array[];
}

const EMPTY = new Uint8Array(0);

/** ChaChaPoly nonce per Noise spec: 32 bits of zeros + little-endian 64-bit counter. */
export function chachaNonce(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const dv = new DataView(nonce.buffer);
  dv.setUint32(4, n >>> 0, true);
  dv.setUint32(8, Math.floor(n / 0x1_0000_0000), true);
  return nonce;
}

export function hkdfBlocks(
  hash: Parameters<typeof hkdf>[0],
  hashLen: number,
  ck: Uint8Array,
  ikm: Uint8Array,
  outputs: 2 | 3,
): Uint8Array[] {
  const okm = hkdf(hash, ikm, ck, EMPTY, hashLen * outputs);
  const out: Uint8Array[] = [];
  for (let i = 0; i < outputs; i++) out.push(okm.slice(i * hashLen, (i + 1) * hashLen));
  return out;
}

/** Raw-bytes X25519 key pair (daemon, CLI, ephemerals). */
export function x25519KeyPair(secretKey?: Uint8Array): KeyPair & { readonly secretKey: Uint8Array } {
  const sk = secretKey ?? x25519.utils.randomSecretKey();
  const pk = x25519.getPublicKey(sk);
  return {
    publicKey: pk,
    secretKey: sk,
    // noble rejects low-order points (throws) instead of returning an all-zero secret.
    dh: (remotePublic: Uint8Array) => x25519.getSharedSecret(sk, remotePublic),
  };
}

export const Noise_25519_ChaChaPoly_BLAKE2s: Suite = {
  name: '25519_ChaChaPoly_BLAKE2s',
  dhLen: 32,
  hashLen: 32,
  generateKeyPair: () => x25519KeyPair(),
  encrypt: (k, n, ad, pt) => chacha20poly1305(k, chachaNonce(n), ad).encrypt(pt),
  decrypt: (k, n, ad, ct) => chacha20poly1305(k, chachaNonce(n), ad).decrypt(ct),
  hash: (data) => blake2s(data),
  hkdf: (ck, ikm, outputs) => hkdfBlocks(blake2s, 32, ck, ikm, outputs),
};

/**
 * Adapter for a WebCrypto X25519 key pair whose private key is NON-extractable
 * (browser device key persisted in IndexedDB). DH is async -> the state machine awaits it.
 */
export async function webCryptoX25519KeyPair(pair: CryptoKeyPair, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<KeyPair> {
  const publicKey = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  return {
    publicKey,
    async dh(remotePublic: Uint8Array): Promise<Uint8Array> {
      const remote = await subtle.importKey('raw', remotePublic as Uint8Array<ArrayBuffer>, { name: 'X25519' }, true, []);
      const bits = await subtle.deriveBits({ name: 'X25519', public: remote }, pair.privateKey, 256);
      return new Uint8Array(bits);
    },
  };
}
```

### `src/noise.ts`

```ts
// Noise Protocol Framework state machine (rev 34, sections 5, 7, 9).
// Only the *state machine* lives here; primitives come from a Suite (audited libs).
// Validated against the cacophony + snow test vectors (see test/vectors.run.ts).

import type { KeyPair, Suite } from './suite.ts';
import { EMPTY, concat, utf8 } from './bytes.ts';

export const MAX_MESSAGE_LEN = 65535;
const TAG_LEN = 16;
/** Spec reserves 2^64-1; we cap at 2^53-1 (JS safe integer). Unreachable in practice. */
const MAX_NONCE = Number.MAX_SAFE_INTEGER;

export type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk';
export type PreToken = 'e' | 's';

export interface HandshakePattern {
  /** Pattern name incl. modifiers, e.g. "XXpsk3". */
  readonly name: string;
  readonly initiatorPre: readonly PreToken[];
  readonly responderPre: readonly PreToken[];
  /** messages[0] is sent by the initiator, then strictly alternating. */
  readonly messages: readonly (readonly Token[])[];
}

export class NoiseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'NoiseError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- patterns

/** Base patterns smurg uses. (The full rev-34 table lives in test/patterns-all.ts for vector tests.) */
export const BASE_PATTERNS: Record<string, HandshakePattern> = {
  XX: { name: 'XX', initiatorPre: [], responderPre: [], messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']] },
  IK: { name: 'IK', initiatorPre: [], responderPre: ['s'], messages: [['e', 'es', 's', 'ss'], ['e', 'ee', 'se']] },
  KK: { name: 'KK', initiatorPre: ['s'], responderPre: ['s'], messages: [['e', 'es', 'ss'], ['e', 'ee', 'se']] },
  NN: { name: 'NN', initiatorPre: [], responderPre: [], messages: [['e'], ['e', 'ee']] },
};

/**
 * Apply psk modifiers (section 9.2): "psk0" prepends a psk token to the first message,
 * "pskN" (N>=1) appends one to the N-th message. Multiple modifiers joined by "+".
 */
export function withModifiers(base: HandshakePattern, modifiers: string): HandshakePattern {
  if (!modifiers) return base;
  const messages = base.messages.map((m) => [...m]);
  for (const mod of modifiers.split('+')) {
    const m = /^psk(\d+)$/.exec(mod);
    if (!m) throw new NoiseError('bad-pattern', `unsupported modifier ${mod}`);
    const n = Number(m[1]);
    if (n === 0) messages[0].unshift('psk');
    else if (n <= messages.length) messages[n - 1].push('psk');
    else throw new NoiseError('bad-pattern', `${mod} out of range`);
  }
  return { ...base, name: base.name + modifiers, messages };
}

/** Resolve "XXpsk3" etc. against a table of base patterns. */
export function resolvePattern(name: string, table: Record<string, HandshakePattern> = BASE_PATTERNS): HandshakePattern {
  const m = /^([A-Z0-9]+?)((?:psk\d+\+?)*)$/.exec(name);
  if (!m || !table[m[1]]) throw new NoiseError('bad-pattern', `unknown pattern ${name}`);
  return withModifiers(table[m[1]], m[2]);
}

// ---------------------------------------------------------------- CipherState

export class CipherState {
  private readonly suite: Suite;
  private k: Uint8Array | null = null;
  private n = 0;

  constructor(suite: Suite, k: Uint8Array | null = null) {
    this.suite = suite;
    this.k = k;
  }

  initializeKey(k: Uint8Array | null): void {
    this.k = k;
    this.n = 0;
  }

  hasKey(): boolean {
    return this.k !== null;
  }

  get nonce(): number {
    return this.n;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.k === null) return plaintext;
    if (this.n >= MAX_NONCE) throw new NoiseError('nonce-exhausted', 'nonce exhausted; rekey or re-handshake');
    const ct = this.suite.encrypt(this.k, this.n, ad, plaintext);
    this.n++;
    return ct;
  }

  /** Throws NoiseError('decrypt') on auth failure; nonce is NOT advanced on failure (spec 5.1). */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.k === null) return ciphertext;
    if (this.n >= MAX_NONCE) throw new NoiseError('nonce-exhausted', 'nonce exhausted');
    let pt: Uint8Array;
    try {
      pt = this.suite.decrypt(this.k, this.n, ad, ciphertext);
    } catch {
      throw new NoiseError('decrypt', 'authentication tag mismatch');
    }
    this.n++;
    return pt;
  }
}

// ---------------------------------------------------------------- SymmetricState

export class SymmetricState {
  readonly suite: Suite;
  readonly cs: CipherState;
  private ck: Uint8Array;
  private h: Uint8Array;

  constructor(suite: Suite, protocolName: string) {
    this.suite = suite;
    const name = utf8(protocolName);
    if (name.length <= suite.hashLen) {
      this.h = new Uint8Array(suite.hashLen);
      this.h.set(name);
    } else {
      this.h = suite.hash(name);
    }
    this.ck = this.h.slice();
    this.cs = new CipherState(suite);
  }

  private truncKey(k: Uint8Array): Uint8Array {
    return k.length === 32 ? k : k.slice(0, 32);
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, tempK] = this.suite.hkdf(this.ck, ikm, 2);
    this.ck = ck;
    this.cs.initializeKey(this.truncKey(tempK));
  }

  mixHash(data: Uint8Array): void {
    this.h = this.suite.hash(concat(this.h, data));
  }

  mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, tempH, tempK] = this.suite.hkdf(this.ck, ikm, 3);
    this.ck = ck;
    this.mixHash(tempH);
    this.cs.initializeKey(this.truncKey(tempK));
  }

  get handshakeHash(): Uint8Array {
    return this.h.slice();
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ct = this.cs.encryptWithAd(this.h, plaintext);
    this.mixHash(ct);
    return ct;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const pt = this.cs.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return pt;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = this.suite.hkdf(this.ck, EMPTY, 2);
    return [new CipherState(this.suite, this.truncKey(k1)), new CipherState(this.suite, this.truncKey(k2))];
  }
}

// ---------------------------------------------------------------- HandshakeState

export interface HandshakeOptions {
  suite: Suite;
  pattern: HandshakePattern;
  initiator: boolean;
  prologue?: Uint8Array;
  /** Local static key pair (may be backed by a non-extractable WebCrypto key). */
  s?: KeyPair;
  /** Fixed local ephemeral. TEST VECTORS ONLY. */
  e?: KeyPair;
  /** Remote static public key known in advance (pre-message), e.g. IK/KK. */
  rs?: Uint8Array;
  re?: Uint8Array;
  psks?: Uint8Array[];
}

export interface TransportKeys {
  send: CipherState;
  recv: CipherState;
  handshakeHash: Uint8Array;
  remoteStatic: Uint8Array | null;
}

export class HandshakeState {
  readonly protocolName: string;
  private readonly ss: SymmetricState;
  private readonly suite: Suite;
  private readonly pattern: HandshakePattern;
  private readonly initiator: boolean;
  private readonly isPsk: boolean;
  private readonly psks: Uint8Array[];
  private s: KeyPair | undefined;
  private e: KeyPair | undefined;
  private rs: Uint8Array | undefined;
  private re: Uint8Array | undefined;
  private msgIndex = 0;
  private failed = false;
  private busy = false;
  private result: TransportKeys | null = null;

  constructor(opts: HandshakeOptions) {
    this.suite = opts.suite;
    this.pattern = opts.pattern;
    this.initiator = opts.initiator;
    this.s = opts.s;
    this.e = opts.e;
    this.rs = opts.rs;
    this.re = opts.re;
    this.psks = [...(opts.psks ?? [])];
    const pskTokens = this.pattern.messages.flat().filter((t) => t === 'psk').length;
    this.isPsk = pskTokens > 0;
    if (this.psks.length !== pskTokens) throw new NoiseError('bad-config', `pattern needs ${pskTokens} psk(s), got ${this.psks.length}`);
    for (const p of this.psks) if (p.length !== 32) throw new NoiseError('bad-config', 'psk must be 32 bytes');

    this.protocolName = `Noise_${this.pattern.name}_${this.suite.name}`;
    this.ss = new SymmetricState(this.suite, this.protocolName);
    this.ss.mixHash(opts.prologue ?? EMPTY);
    // Pre-messages: initiator's first, then responder's (section 7.1).
    this.mixPre(this.pattern.initiatorPre, this.initiator);
    this.mixPre(this.pattern.responderPre, !this.initiator);
  }

  private mixPre(tokens: readonly PreToken[], mine: boolean): void {
    for (const t of tokens) {
      const key = t === 's' ? (mine ? this.s?.publicKey : this.rs) : mine ? this.e?.publicKey : this.re;
      if (!key) throw new NoiseError('bad-config', `missing pre-message key ${t}`);
      this.ss.mixHash(key);
      if (t === 'e' && this.isPsk) this.ss.mixKey(key);
    }
  }

  get isComplete(): boolean {
    return this.result !== null;
  }

  /** Remote static public key once learned (or pre-known). */
  get remoteStatic(): Uint8Array | null {
    return this.rs ?? null;
  }

  get handshakeHash(): Uint8Array {
    return this.ss.handshakeHash;
  }

  /** Whose turn: true if this side must call writeMessage next. */
  get isMyTurn(): boolean {
    return !this.isComplete && (this.msgIndex % 2 === 0) === this.initiator;
  }

  get messageIndex(): number {
    return this.msgIndex;
  }

  /** Transport keys; only after the last handshake message. */
  split(): TransportKeys {
    if (!this.result) throw new NoiseError('state', 'handshake not complete');
    return this.result;
  }

  private enter(write: boolean): readonly Token[] {
    if (this.failed) throw new NoiseError('state', 'handshake already failed');
    if (this.busy) throw new NoiseError('state', 'concurrent handshake call');
    if (this.isComplete) throw new NoiseError('state', 'handshake already complete');
    if (this.isMyTurn !== write) throw new NoiseError('state', write ? 'not our turn to write' : 'not our turn to read');
    this.busy = true;
    return this.pattern.messages[this.msgIndex];
  }

  private async dh(local: KeyPair | undefined, remote: Uint8Array | undefined): Promise<Uint8Array> {
    if (!local || !remote) throw new NoiseError('bad-config', 'missing key for DH');
    return await local.dh(remote);
  }

  private async mixToken(t: Token): Promise<void> {
    switch (t) {
      case 'ee':
        this.ss.mixKey(await this.dh(this.e, this.re));
        break;
      case 'es':
        this.ss.mixKey(this.initiator ? await this.dh(this.e, this.rs) : await this.dh(this.s, this.re));
        break;
      case 'se':
        this.ss.mixKey(this.initiator ? await this.dh(this.s, this.re) : await this.dh(this.e, this.rs));
        break;
      case 'ss':
        this.ss.mixKey(await this.dh(this.s, this.rs));
        break;
      case 'psk': {
        const psk = this.psks.shift();
        if (!psk) throw new NoiseError('bad-config', 'psk missing');
        this.ss.mixKeyAndHash(psk);
        break;
      }
      default:
        throw new NoiseError('bad-pattern', `unexpected token ${t}`);
    }
  }

  private finishMessage(): void {
    this.msgIndex++;
    if (this.msgIndex === this.pattern.messages.length) {
      const [c1, c2] = this.ss.split();
      this.result = {
        send: this.initiator ? c1 : c2,
        recv: this.initiator ? c2 : c1,
        handshakeHash: this.ss.handshakeHash,
        remoteStatic: this.rs ?? null,
      };
    }
  }

  async writeMessage(payload: Uint8Array = EMPTY): Promise<Uint8Array> {
    const tokens = this.enter(true);
    try {
      const parts: Uint8Array[] = [];
      for (const t of tokens) {
        if (t === 'e') {
          if (!this.e) this.e = this.suite.generateKeyPair();
          parts.push(this.e.publicKey);
          this.ss.mixHash(this.e.publicKey);
          if (this.isPsk) this.ss.mixKey(this.e.publicKey);
        } else if (t === 's') {
          if (!this.s) throw new NoiseError('bad-config', 'local static key required');
          parts.push(this.ss.encryptAndHash(this.s.publicKey));
        } else {
          await this.mixToken(t);
        }
      }
      parts.push(this.ss.encryptAndHash(payload));
      const msg = concat(...parts);
      if (msg.length > MAX_MESSAGE_LEN) throw new NoiseError('too-large', 'handshake message exceeds 65535 bytes');
      this.finishMessage();
      return msg;
    } catch (err) {
      this.failed = true;
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Process one handshake message; returns its decrypted payload.
   * `onRemoteStatic` runs right after the remote static key is decrypted, BEFORE
   * the rest of the message (and before we answer) -- the hook for pinning/allow-lists.
   */
  async readMessage(message: Uint8Array, onRemoteStatic?: (rs: Uint8Array) => void | Promise<void>): Promise<Uint8Array> {
    const tokens = this.enter(false);
    try {
      if (message.length > MAX_MESSAGE_LEN) throw new NoiseError('too-large', 'handshake message exceeds 65535 bytes');
      let off = 0;
      const take = (n: number): Uint8Array => {
        if (off + n > message.length) throw new NoiseError('short', 'handshake message too short');
        const b = message.subarray(off, off + n);
        off += n;
        return b;
      };
      for (const t of tokens) {
        if (t === 'e') {
          this.re = take(this.suite.dhLen).slice();
          this.ss.mixHash(this.re);
          if (this.isPsk) this.ss.mixKey(this.re);
        } else if (t === 's') {
          const len = this.suite.dhLen + (this.ss.cs.hasKey() ? TAG_LEN : 0);
          this.rs = this.ss.decryptAndHash(take(len)).slice();
          if (onRemoteStatic) await onRemoteStatic(this.rs);
        } else {
          await this.mixToken(t);
        }
      }
      const payload = this.ss.decryptAndHash(message.subarray(off));
      this.finishMessage();
      return payload;
    } catch (err) {
      this.failed = true;
      throw err;
    } finally {
      this.busy = false;
    }
  }
}
```

### `src/framing.ts`

```ts
// Wire framing for smurg's per-connection Noise channel inside WebSocket binary messages.
//
// Every WS binary message on a client<->daemon connection starts with a 1-byte frame type:
//   0x01 HELLO   client->daemon  [0x01][ver=1][mode][noise msg1]   (inviteId is NOT sent; it is in the prologue)
//   0x02 REPLY   daemon->client  [0x02][noise msg2]
//   0x03 FINISH  client->daemon  [0x03][noise msg3]
//   0x10 DATA    both            [0x10] { [u16be len][noise transport msg (len bytes)] }+
//   0x7f ABORT   both            [0x7f][reason]   (cleartext, unauthenticated -> UX hint only)
//
// DATA records: plaintext = [flags u8][body]; flags bit0 = FIN (last record of one app message).
// A Noise transport message is <= 65535 bytes => body <= 65535 - 16 (tag) - 1 (flags) = 65518.
// App message boundaries are carried INSIDE the ciphertext (FIN flag), so a relay that
// re-splits/merges WS messages cannot merge/split app messages; dropping or reordering a
// record breaks the nonce sequence and is fatal.

import { NoiseError, type CipherState } from './noise.ts';
import { EMPTY } from './bytes.ts';

export const FRAME = { HELLO: 0x01, REPLY: 0x02, FINISH: 0x03, DATA: 0x10, ABORT: 0x7f } as const;
export const NOISE_MAX = 65535;
export const TAG_LEN = 16;
export const MAX_BODY = NOISE_MAX - TAG_LEN - 1; // 65518
const FIN = 0x01;

/** Encrypts app messages (any size) into one DATA frame each. */
export class Sealer {
  private readonly cs: CipherState;
  constructor(cs: CipherState) {
    this.cs = cs;
  }

  seal(message: Uint8Array): Uint8Array {
    const records = Math.max(1, Math.ceil(message.length / MAX_BODY));
    const out = new Uint8Array(1 + records * (2 + 1 + TAG_LEN) + message.length);
    out[0] = FRAME.DATA;
    let off = 1;
    const pt = new Uint8Array(1 + Math.min(MAX_BODY, message.length));
    for (let r = 0; r < records; r++) {
      const start = r * MAX_BODY;
      const body = message.subarray(start, Math.min(start + MAX_BODY, message.length));
      const rec = body.length + 1 === pt.length ? pt : pt.subarray(0, body.length + 1);
      rec[0] = r === records - 1 ? FIN : 0;
      rec.set(body, 1);
      const ct = this.cs.encryptWithAd(EMPTY, rec);
      out[off] = ct.length >>> 8;
      out[off + 1] = ct.length & 0xff;
      out.set(ct, off + 2);
      off += 2 + ct.length;
    }
    return out;
  }
}

/** Decrypts DATA frames; returns completed app messages. Any error is fatal (channel poisoned). */
export class Opener {
  private readonly cs: CipherState;
  private readonly maxMessage: number;
  private parts: Uint8Array[] = [];
  private partLen = 0;
  private dead = false;

  constructor(cs: CipherState, maxMessageBytes = 9 * 1024 * 1024) {
    this.cs = cs;
    this.maxMessage = maxMessageBytes;
  }

  open(frame: Uint8Array): Uint8Array[] {
    if (this.dead) throw new NoiseError('closed', 'channel is dead after a previous error');
    try {
      if (frame[0] !== FRAME.DATA) throw new NoiseError('frame', `unexpected frame type ${frame[0]}`);
      const done: Uint8Array[] = [];
      let off = 1;
      while (off < frame.length) {
        if (off + 2 > frame.length) throw new NoiseError('frame', 'truncated record header');
        const len = (frame[off] << 8) | frame[off + 1];
        if (len < TAG_LEN + 1 || off + 2 + len > frame.length) throw new NoiseError('frame', 'bad record length');
        const pt = this.cs.decryptWithAd(EMPTY, frame.subarray(off + 2, off + 2 + len));
        off += 2 + len;
        const body = pt.subarray(1);
        this.partLen += body.length;
        if (this.partLen > this.maxMessage) throw new NoiseError('too-large', 'app message exceeds limit');
        this.parts.push(body);
        if (pt[0] & FIN) {
          done.push(joinParts(this.parts, this.partLen));
          this.parts = [];
          this.partLen = 0;
        }
      }
      return done;
    } catch (e) {
      this.dead = true;
      throw e;
    }
  }
}

function joinParts(parts: Uint8Array[], len: number): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
```

### `src/invite.ts`

```ts
// Invite link fragment (#k=...&s=...), invite id / PSK derivation, and the Noise prologue.
import { blake2s } from '@noble/hashes/blake2.js';
import { concat, fromBase64Url, toBase64Url, toHex, utf8 } from './bytes.ts';

export const MODE = { INVITE: 0x01, DEVICE: 0x02 } as const;
export type Mode = (typeof MODE)[keyof typeof MODE];

const FP_LABEL = utf8('smurg/v1 daemon static key fingerprint');
const ID_LABEL = utf8('smurg/v1 invite id');
const PSK_LABEL = utf8('smurg/v1 invite psk');

/** k: 32-byte BLAKE2s over a domain label + the daemon's X25519 static public key. */
export function daemonFingerprint(daemonStaticPub: Uint8Array): Uint8Array {
  return blake2s(concat(FP_LABEL, daemonStaticPub));
}

/** Short human-comparable form for UI ("safety number"): first 10 bytes as 5 groups of hex. */
export function fingerprintForHumans(fp: Uint8Array): string {
  return toHex(fp.subarray(0, 10)).match(/.{4}/g)!.join(' ');
}

/**
 * From the one-time secret s (32 random bytes) derive, with keyed BLAKE2s (a PRF):
 *  - inviteId (16 bytes): never sent on the wire; it goes into the Noise prologue. The daemon
 *    identifies the invite by trial-verifying msg1 (whose AEAD tag has AD = h(prologue)).
 *  - psk (32 bytes, secret, the Noise psk3 value)
 * The daemon stores only {inviteId, psk, role, expiry, usesLeft}; s itself need not be stored.
 */
export function deriveInvite(s: Uint8Array): { inviteId: Uint8Array; psk: Uint8Array } {
  if (s.length !== 32) throw new Error('invite secret must be 32 bytes');
  return {
    inviteId: blake2s(ID_LABEL, { key: s, dkLen: 16 }),
    psk: blake2s(PSK_LABEL, { key: s, dkLen: 32 }),
  };
}

export function newInviteSecret(): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export function buildInviteUrl(origin: string, workspaceId: string, daemonStaticPub: Uint8Array, s: Uint8Array): string {
  const k = toBase64Url(daemonFingerprint(daemonStaticPub));
  return `${origin}/join/${encodeURIComponent(workspaceId)}#k=${k}&s=${toBase64Url(s)}`;
}

/** Strict parser: exactly k and s, each base64url(32 bytes) = 43 chars. */
export function parseInviteFragment(hash: string): { k: Uint8Array; s: Uint8Array } {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const keys = [...params.keys()].sort().join(',');
  if (keys !== 'k,s') throw new Error('invite fragment must contain exactly k and s');
  const k = fromBase64Url(params.get('k')!);
  const s = fromBase64Url(params.get('s')!);
  if (k.length !== 32 || s.length !== 32) throw new Error('k and s must be 32 bytes');
  return { k, s };
}

/**
 * Prologue binds everything both sides rely on that is NOT otherwise inside the handshake:
 * protocol/version label, workspace id, mode (sent in clear in HELLO), and in invite mode the
 * inviteId (never sent). Any mismatch/tampering makes the handshake fail.
 */
export function buildPrologue(workspaceId: string, mode: Mode, inviteId?: Uint8Array): Uint8Array {
  const wid = utf8(workspaceId);
  if (wid.length > 255) throw new Error('workspaceId too long');
  if ((mode === MODE.INVITE) !== (inviteId?.length === 16)) throw new Error('inviteId required iff invite mode');
  return concat(utf8('smurg-noise/1'), new Uint8Array([0, wid.length]), wid, new Uint8Array([mode]), inviteId ?? new Uint8Array(0));
}
```

### `src/channel.ts`

```ts
// smurg handshake drivers: client (web/CLI) <-> daemon, through an untrusted relay.
//   first contact : Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s, psk = derived from invite secret s,
//                   daemon static key checked against fingerprint k from the invite fragment.
//   reconnect     : Noise_XX_25519_ChaChaPoly_BLAKE2s, mutual static-key pinning
//                   (client pins daemon key learned at first contact; daemon checks device registry).
import { HandshakeState, NoiseError, resolvePattern } from './noise.ts';
import { Noise_25519_ChaChaPoly_BLAKE2s, type KeyPair } from './suite.ts';
import { FRAME, Opener, Sealer } from './framing.ts';
import { MODE, buildPrologue, daemonFingerprint, deriveInvite, type Mode } from './invite.ts';
import { EMPTY, concat, equalBytes } from './bytes.ts';

export interface FrameIO {
  send(frame: Uint8Array): void | Promise<void>;
  /** Resolves with the next WS binary message of this connection. */
  recv(): Promise<Uint8Array>;
}

export const ABORT_REASON = {
  'invite-unknown': 1,
  'invite-expired': 2,
  'invite-exhausted': 3,
  'device-unknown': 4,
  'device-revoked': 5,
  'handshake-failed': 6,
  'bad-hello': 7,
} as const;
export type AbortReason = keyof typeof ABORT_REASON;
const REASON_BY_CODE = Object.fromEntries(Object.entries(ABORT_REASON).map(([k, v]) => [v, k])) as Record<number, AbortReason>;

export class ChannelError extends Error {
  readonly code: string;
  /** Which handshake message the failure was detected at (1..3), if applicable. */
  readonly atMessage?: number;
  constructor(code: string, message: string, atMessage?: number) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
    this.atMessage = atMessage;
  }
}

export class SecureChannel {
  readonly handshakeHash: Uint8Array;
  readonly remoteStatic: Uint8Array;
  private readonly sealer: Sealer;
  private readonly opener: Opener;
  constructor(sealer: Sealer, opener: Opener, handshakeHash: Uint8Array, remoteStatic: Uint8Array) {
    this.sealer = sealer;
    this.opener = opener;
    this.handshakeHash = handshakeHash;
    this.remoteStatic = remoteStatic;
  }
  /** App message (any size up to the peer's limit) -> one DATA frame. */
  seal(message: Uint8Array): Uint8Array {
    return this.sealer.seal(message);
  }
  /** DATA frame -> 0..n complete app messages. Throws (fatally) on any tampering. */
  open(frame: Uint8Array): Uint8Array[] {
    return this.opener.open(frame);
  }
}

const suite = Noise_25519_ChaChaPoly_BLAKE2s;
const abortFrame = (r: AbortReason) => new Uint8Array([FRAME.ABORT, ABORT_REASON[r]]);

async function expect(io: FrameIO, type: number, at: number): Promise<Uint8Array> {
  const f = await io.recv();
  if (f[0] === FRAME.ABORT) {
    const reason = REASON_BY_CODE[f[1]] ?? 'unknown';
    throw new ChannelError(`aborted:${reason}`, `peer aborted: ${reason}`, at);
  }
  if (f[0] !== type) throw new ChannelError('protocol', `expected frame ${type}, got ${f[0]}`, at);
  return f.subarray(1);
}

function channelFrom(hs: HandshakeState): SecureChannel {
  const t = hs.split();
  return new SecureChannel(new Sealer(t.send), new Opener(t.recv), t.handshakeHash, t.remoteStatic!);
}

// ------------------------------------------------------------------ client

export type ClientTrust =
  | { kind: 'invite'; fingerprint: Uint8Array; secret: Uint8Array }
  | { kind: 'pinned'; daemonKey: Uint8Array };

export interface ClientOptions {
  workspaceId: string;
  deviceKey: KeyPair;
  trust: ClientTrust;
  /** Encrypted payload of msg3 (e.g. display name / profile). */
  hello?: Uint8Array;
  /** TEST ONLY: override the derived psk while keeping the real inviteId (shows where a wrong PSK is detected). */
  _pskOverride?: Uint8Array;
}

export async function clientConnect(io: FrameIO, o: ClientOptions): Promise<{ channel: SecureChannel; daemonKey: Uint8Array; welcome: Uint8Array }> {
  const invite = o.trust.kind === 'invite' ? deriveInvite(o.trust.secret) : null;
  const mode: Mode = invite ? MODE.INVITE : MODE.DEVICE;
  const hs = new HandshakeState({
    suite,
    pattern: resolvePattern(invite ? 'XXpsk3' : 'XX'),
    initiator: true,
    prologue: buildPrologue(o.workspaceId, mode, invite?.inviteId),
    s: o.deviceKey,
    psks: invite ? [o._pskOverride ?? invite.psk] : [],
  });
  const msg1 = await hs.writeMessage();
  // inviteId is NOT sent: it is only in the prologue; the daemon finds the invite by trial-verifying msg1.
  await io.send(concat(new Uint8Array([FRAME.HELLO, 1, mode]), msg1));

  const msg2 = await expect(io, FRAME.REPLY, 2);
  try {
    await hs.readMessage(msg2, (rs) => {
      const ok = o.trust.kind === 'invite' ? equalBytes(daemonFingerprint(rs), o.trust.fingerprint) : equalBytes(rs, o.trust.daemonKey);
      if (!ok) throw new ChannelError('daemon-key-mismatch', 'daemon static key does not match the invite fingerprint / pinned key', 2);
    });
  } catch (e) {
    await io.send(abortFrame('handshake-failed'));
    if (e instanceof ChannelError) throw e;
    throw new ChannelError('handshake-failed', `msg2 rejected: ${(e as Error).message}`, 2);
  }
  // Daemon is now authenticated (its static key matched and it proved possession via es).
  const msg3 = await hs.writeMessage(o.hello ?? EMPTY);
  await io.send(concat(new Uint8Array([FRAME.FINISH]), msg3));
  const channel = channelFrom(hs);
  // Key confirmation: the daemon only answers with an encrypted WELCOME if msg3 (psk, client key) was accepted.
  const first = await io.recv();
  if (first[0] === FRAME.ABORT) {
    const reason = REASON_BY_CODE[first[1]] ?? 'unknown';
    throw new ChannelError(`aborted:${reason}`, `daemon rejected msg3: ${reason}`, 3);
  }
  const [welcome] = channel.open(first);
  if (!welcome) throw new ChannelError('protocol', 'welcome must be a single complete message', 3);
  return { channel, daemonKey: hs.remoteStatic!, welcome };
}

// ------------------------------------------------------------------ daemon

export interface InviteRecord {
  inviteId: Uint8Array;
  psk: Uint8Array;
  /** Keep expired/used-up invites around for a while so the user gets a precise error. */
  status: 'ok' | 'invite-expired' | 'invite-exhausted';
}

export interface DaemonPolicy {
  /** All invites of this workspace (active + recently expired/exhausted). Typically < 10. */
  invites(): Iterable<InviteRecord>;
  /** Called as soon as the client's static key is decrypted (msg3), BEFORE it is authenticated: may only reject. */
  checkDevice(devicePub: Uint8Array, mode: Mode): 'ok' | 'device-unknown' | 'device-revoked';
  /** Called once msg3 is fully authenticated (psk + client static proven). Register device / consume invite use here. */
  onAccepted(info: { mode: Mode; devicePub: Uint8Array; inviteId?: Uint8Array; hello: Uint8Array }): void | Promise<void>;
}

export interface DaemonOptions {
  workspaceId: string;
  staticKey: KeyPair;
  policy: DaemonPolicy;
  welcome: (info: { mode: Mode; devicePub: Uint8Array }) => Uint8Array;
}

function responder(o: DaemonOptions, mode: Mode, invite?: InviteRecord): HandshakeState {
  return new HandshakeState({
    suite,
    pattern: resolvePattern(invite ? 'XXpsk3' : 'XX'),
    initiator: false,
    prologue: buildPrologue(o.workspaceId, mode, invite?.inviteId),
    s: o.staticKey,
    psks: invite ? [invite.psk] : [],
  });
}

export async function daemonAccept(io: FrameIO, o: DaemonOptions) {
  const hello = await expect(io, FRAME.HELLO, 1);
  const [ver, rawMode] = hello;
  if (ver !== 1 || (rawMode !== MODE.INVITE && rawMode !== MODE.DEVICE)) {
    await io.send(abortFrame('bad-hello'));
    throw new ChannelError('bad-hello', 'unsupported version/mode', 1);
  }
  const mode = rawMode as Mode;
  const msg1 = hello.subarray(2);
  let hs: HandshakeState | undefined;
  let invite: InviteRecord | undefined;
  let stage = 1;
  try {
    if (mode === MODE.INVITE) {
      // psk-mode "e" does MixKey(e), so msg1 carries a tag with AD = h(prologue incl. inviteId).
      // Only a holder of s (=> inviteId) can produce a msg1 that verifies. No DH is needed for this.
      for (const inv of o.policy.invites()) {
        const cand = responder(o, mode, inv);
        try {
          await cand.readMessage(msg1);
        } catch {
          continue;
        }
        hs = cand;
        invite = inv;
        break;
      }
      if (!hs || !invite) throw new ChannelError('invite-unknown', 'no invite matches msg1', 1);
      if (invite.status !== 'ok') throw new ChannelError(invite.status, 'invite no longer usable', 1);
    } else {
      hs = responder(o, mode);
      await hs.readMessage(msg1); // XX msg1 is unauthenticated (no tag): anything >= 32 bytes passes
    }
    await io.send(concat(new Uint8Array([FRAME.REPLY]), await hs.writeMessage()));
    stage = 3;
    const msg3 = await expect(io, FRAME.FINISH, 3);
    const clientHello = await hs.readMessage(msg3, (rs) => {
      const verdict = o.policy.checkDevice(rs, mode);
      if (verdict !== 'ok') throw new ChannelError(verdict, `device ${verdict}`, 3);
    });
    const devicePub = hs.remoteStatic!;
    await o.policy.onAccepted({ mode, devicePub, inviteId: invite?.inviteId, hello: clientHello });
    const channel = channelFrom(hs);
    await io.send(channel.seal(o.welcome({ mode, devicePub })));
    return { channel, mode, devicePub, inviteId: invite?.inviteId, clientHello };
  } catch (e) {
    const code = e instanceof ChannelError ? e.code : 'handshake-failed';
    if (!code.startsWith('aborted:')) {
      await io.send(abortFrame((code in ABORT_REASON ? code : 'handshake-failed') as AbortReason));
    }
    if (e instanceof ChannelError) throw e;
    const detail = e instanceof NoiseError ? e.code : String(e);
    throw new ChannelError('handshake-failed', `msg${stage} rejected: ${detail}`, stage);
  }
}
```

### `src/device-key.ts`

```ts
// Browser device key: prefer a NON-extractable WebCrypto X25519 key (persist the CryptoKeyPair
// object itself in IndexedDB); fall back to raw noble bytes where X25519 WebCrypto is missing.
import { x25519 } from '@noble/curves/ed25519.js';
import { equalBytes } from './bytes.ts';
import { webCryptoX25519KeyPair, x25519KeyPair, type KeyPair } from './suite.ts';

export type DeviceKeyRecord =
  | { kind: 'webcrypto'; pair: CryptoKeyPair } // store as-is in IndexedDB (structured clone keeps extractable=false)
  | { kind: 'raw'; secretKey: Uint8Array }; // fallback: bytes in IndexedDB (readable by any same-origin script)

export async function createDeviceKeyRecord(subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<DeviceKeyRecord> {
  try {
    const pair = (await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
    // Self-test once: platform X25519 must agree with noble (guards against partial implementations).
    const probe = x25519.utils.randomSecretKey();
    const kp = await webCryptoX25519KeyPair(pair, subtle);
    const a = await kp.dh(x25519.getPublicKey(probe));
    if (!equalBytes(a, x25519.getSharedSecret(probe, kp.publicKey))) throw new Error('X25519 self-test failed');
    return { kind: 'webcrypto', pair };
  } catch {
    return { kind: 'raw', secretKey: x25519.utils.randomSecretKey() };
  }
}

export async function keyPairFromRecord(r: DeviceKeyRecord, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<KeyPair> {
  return r.kind === 'webcrypto' ? webCryptoX25519KeyPair(r.pair, subtle) : x25519KeyPair(r.secretKey);
}
```

## Appendix B: vector-test support (verbatim from spike `test/`; keep in the protocol package CI)

### `test/patterns-all.ts`

```ts
// Full Noise rev-34 pattern table (one-way 7.4, interactive 7.5, deferred 7.6).
// Test-only: used to run the ENTIRE cacophony/snow vector corpus through our state machine.
import type { HandshakePattern, PreToken, Token } from '../src/noise.ts';

function p(name: string, spec: string): HandshakePattern {
  // spec lines: "-> s" / "<- s" pre-messages before "...", then messages.
  const [preRaw, msgRaw] = spec.includes('...') ? spec.split('...') : ['', spec];
  const initiatorPre: PreToken[] = [];
  const responderPre: PreToken[] = [];
  for (const line of preRaw.split(';').map((l) => l.trim()).filter(Boolean)) {
    const toks = line.slice(2).split(',').map((t) => t.trim()) as PreToken[];
    (line.startsWith('->') ? initiatorPre : responderPre).push(...toks);
  }
  const messages: Token[][] = msgRaw
    .split(';')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.slice(2).split(',').map((t) => t.trim()) as Token[]);
  return { name, initiatorPre, responderPre, messages };
}

const DEFS: Record<string, string> = {
  // one-way
  N: '<- s ... -> e, es',
  K: '-> s; <- s ... -> e, es, ss',
  X: '<- s ... -> e, es, s, ss',
  // interactive fundamental
  NN: '-> e; <- e, ee',
  NK: '<- s ... -> e, es; <- e, ee',
  NX: '-> e; <- e, ee, s, es',
  XN: '-> e; <- e, ee; -> s, se',
  XK: '<- s ... -> e, es; <- e, ee; -> s, se',
  XX: '-> e; <- e, ee, s, es; -> s, se',
  KN: '-> s ... -> e; <- e, ee, se',
  KK: '-> s; <- s ... -> e, es, ss; <- e, ee, se',
  KX: '-> s ... -> e; <- e, ee, se, s, es',
  IN: '-> e, s; <- e, ee, se',
  IK: '<- s ... -> e, es, s, ss; <- e, ee, se',
  IX: '-> e, s; <- e, ee, se, s, es',
  // deferred
  NK1: '<- s ... -> e; <- e, ee, es',
  NX1: '-> e; <- e, ee, s; -> es',
  X1N: '-> e; <- e, ee; -> s; <- se',
  X1K: '<- s ... -> e, es; <- e, ee; -> s; <- se',
  XK1: '<- s ... -> e; <- e, ee, es; -> s, se',
  X1K1: '<- s ... -> e; <- e, ee, es; -> s; <- se',
  X1X: '-> e; <- e, ee, s, es; -> s; <- se',
  XX1: '-> e; <- e, ee, s; -> es, s, se',
  X1X1: '-> e; <- e, ee, s; -> es, s; <- se',
  K1N: '-> s ... -> e; <- e, ee; -> se',
  K1K: '-> s; <- s ... -> e, es; <- e, ee; -> se',
  KK1: '-> s; <- s ... -> e; <- e, ee, se, es',
  K1K1: '-> s; <- s ... -> e; <- e, ee, es; -> se',
  K1X: '-> s ... -> e; <- e, ee, s, es; -> se',
  KX1: '-> s ... -> e; <- e, ee, se, s; -> es',
  K1X1: '-> s ... -> e; <- e, ee, s; -> se, es',
  I1N: '-> e, s; <- e, ee; -> se',
  I1K: '<- s ... -> e, es, s; <- e, ee; -> se',
  IK1: '<- s ... -> e, s; <- e, ee, se, es',
  I1K1: '<- s ... -> e, s; <- e, ee, es; -> se',
  I1X: '-> e, s; <- e, ee, s, es; -> se',
  IX1: '-> e, s; <- e, ee, se, s; -> es',
  I1X1: '-> e, s; <- e, ee, s; -> se, es',
};

export const ALL_PATTERNS: Record<string, HandshakePattern> = Object.fromEntries(
  Object.entries(DEFS).map(([n, s]) => [n, p(n, s)]),
);

export const ONE_WAY = new Set(['N', 'K', 'X']);
```

### `test/suites-all.ts`

```ts
// Test-only: every DH/cipher/hash combination that appears in the vector files, built from @noble.
// Lets us push the full cacophony + snow corpus through the same state machine.
import { x25519 } from '@noble/curves/ed25519.js';
import { x448 } from '@noble/curves/ed448.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { gcm } from '@noble/ciphers/aes.js';
import { blake2s, blake2b } from '@noble/hashes/blake2.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { chachaNonce, hkdfBlocks, type KeyPair, type Suite } from '../src/suite.ts';

type Curve = typeof x25519;
const CURVES: Record<string, { curve: Curve; len: number }> = {
  '25519': { curve: x25519, len: 32 },
  '448': { curve: x448 as unknown as Curve, len: 56 },
};

function gcmNonce(n: number): Uint8Array {
  const nonce = new Uint8Array(12);
  const dv = new DataView(nonce.buffer);
  dv.setUint32(4, Math.floor(n / 0x1_0000_0000), false);
  dv.setUint32(8, n >>> 0, false);
  return nonce;
}

const CIPHERS = {
  ChaChaPoly: {
    enc: (k: Uint8Array, n: number, ad: Uint8Array, pt: Uint8Array) => chacha20poly1305(k, chachaNonce(n), ad).encrypt(pt),
    dec: (k: Uint8Array, n: number, ad: Uint8Array, ct: Uint8Array) => chacha20poly1305(k, chachaNonce(n), ad).decrypt(ct),
  },
  AESGCM: {
    enc: (k: Uint8Array, n: number, ad: Uint8Array, pt: Uint8Array) => gcm(k, gcmNonce(n), ad).encrypt(pt),
    dec: (k: Uint8Array, n: number, ad: Uint8Array, ct: Uint8Array) => gcm(k, gcmNonce(n), ad).decrypt(ct),
  },
} as const;

const HASHES = {
  BLAKE2s: { fn: blake2s, len: 32 },
  BLAKE2b: { fn: blake2b, len: 64 },
  SHA256: { fn: sha256, len: 32 },
  SHA512: { fn: sha512, len: 64 },
} as const;

export function keyPairFor(dh: string, secret: Uint8Array): KeyPair {
  const { curve } = CURVES[dh];
  return { publicKey: curve.getPublicKey(secret), dh: (r) => curve.getSharedSecret(secret, r) };
}

export function makeSuite(dh: string, cipher: string, hash: string): Suite | null {
  const c = CURVES[dh];
  const ci = (CIPHERS as Record<string, (typeof CIPHERS)['ChaChaPoly']>)[cipher];
  const h = (HASHES as unknown as Record<string, { fn: typeof sha256; len: number }>)[hash];
  if (!c || !ci || !h) return null;
  return {
    name: `${dh}_${cipher}_${hash}`,
    dhLen: c.len,
    hashLen: h.len,
    generateKeyPair: () => keyPairFor(dh, c.curve.utils.randomSecretKey()),
    encrypt: ci.enc,
    decrypt: ci.dec,
    hash: (d) => h.fn(d),
    hkdf: (ck, ikm, n) => hkdfBlocks(h.fn, h.len, ck, ikm, n),
  };
}
```

### `test/vectors-core.ts`

```ts
// Runs Noise JSON test vectors (cacophony / snow format) through src/noise.ts.
// Shared by the Node runner (test/vectors.run.ts) and the browser page (browser/main.ts).
import { HandshakeState, resolvePattern, type TransportKeys } from '../src/noise.ts';
import { EMPTY, equalBytes, fromHex, toHex } from '../src/bytes.ts';
import { ALL_PATTERNS, ONE_WAY } from './patterns-all.ts';
import { keyPairFor, makeSuite } from './suites-all.ts';

export interface Vector {
  protocol_name: string;
  init_prologue: string;
  resp_prologue: string;
  init_static?: string;
  init_ephemeral: string;
  init_remote_static?: string;
  init_psks?: string[];
  resp_static?: string;
  resp_ephemeral?: string;
  resp_remote_static?: string;
  resp_psks?: string[];
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
}

export type VectorOutcome = 'pass' | 'skip' | 'fail';

export async function runVector(v: Vector): Promise<{ outcome: VectorOutcome; detail?: string }> {
  const m = /^Noise_([A-Za-z0-9+]+)_([^_]+)_([^_]+)_([^_]+)$/.exec(v.protocol_name);
  if (!m) return { outcome: 'skip', detail: 'unparsed name' };
  const [, patName, dh, cipher, hash] = m;
  const suite = makeSuite(dh, cipher, hash);
  if (!suite) return { outcome: 'skip', detail: 'suite' };
  let pattern;
  try {
    pattern = resolvePattern(patName, ALL_PATTERNS);
  } catch {
    return { outcome: 'skip', detail: 'pattern' };
  }
  const kp = (hex?: string) => (hex ? keyPairFor(dh, fromHex(hex)) : undefined);
  const hexs = (a?: string[]) => (a ?? []).map(fromHex);
  const init = new HandshakeState({
    suite, pattern, initiator: true, prologue: fromHex(v.init_prologue),
    s: kp(v.init_static), e: kp(v.init_ephemeral),
    rs: v.init_remote_static ? fromHex(v.init_remote_static) : undefined, psks: hexs(v.init_psks),
  });
  const resp = new HandshakeState({
    suite, pattern, initiator: false, prologue: fromHex(v.resp_prologue),
    s: kp(v.resp_static), e: kp(v.resp_ephemeral),
    rs: v.resp_remote_static ? fromHex(v.resp_remote_static) : undefined, psks: hexs(v.resp_psks),
  });
  const oneWay = ONE_WAY.has(pattern.name.replace(/psk.*$/, ''));
  let iT: TransportKeys | null = null;
  let rT: TransportKeys | null = null;
  for (let i = 0; i < v.messages.length; i++) {
    const { payload, ciphertext } = v.messages[i];
    const pt = fromHex(payload);
    const fromInit = oneWay || i % 2 === 0;
    let ct: Uint8Array;
    let back: Uint8Array;
    if (!init.isComplete || !resp.isComplete) {
      const [w, r] = fromInit ? [init, resp] : [resp, init];
      ct = await w.writeMessage(pt);
      back = await r.readMessage(ct);
      if (init.isComplete && resp.isComplete) {
        iT = init.split();
        rT = resp.split();
        if (v.handshake_hash && toHex(iT.handshakeHash) !== v.handshake_hash) return { outcome: 'fail', detail: 'handshake_hash' };
        if (!equalBytes(init.split().handshakeHash, resp.split().handshakeHash)) return { outcome: 'fail', detail: 'h mismatch' };
      }
    } else {
      const [s, r] = fromInit ? [iT!.send, rT!.recv] : [rT!.send, iT!.recv];
      ct = s.encryptWithAd(EMPTY, pt);
      back = r.decryptWithAd(EMPTY, ct);
    }
    if (toHex(ct) !== ciphertext) return { outcome: 'fail', detail: `msg ${i} ciphertext` };
    if (!equalBytes(back, pt)) return { outcome: 'fail', detail: `msg ${i} payload` };
  }
  return { outcome: 'pass' };
}

export async function runAll(vectors: Vector[]) {
  const stats = { pass: 0, skip: 0, fail: 0, failures: [] as string[], passedNames: new Set<string>() };
  for (const v of vectors) {
    let r;
    try {
      r = await runVector(v);
    } catch (e) {
      r = { outcome: 'fail' as const, detail: String(e) };
    }
    stats[r.outcome]++;
    if (r.outcome === 'fail') stats.failures.push(`${v.protocol_name}: ${r.detail}`);
    if (r.outcome === 'pass') stats.passedNames.add(v.protocol_name);
  }
  return stats;
}
```

### `test/vectors.run.ts`

```ts
// node test/vectors.run.ts  -> runs the complete cacophony + snow corpora.
import { readFileSync } from 'node:fs';
import { runAll, runVector, type Vector } from './vectors-core.ts';

const dir = new URL('../vectors/', import.meta.url);
let failed = false;
for (const file of ['cacophony.txt', 'snow.txt']) {
  const vectors: Vector[] = JSON.parse(readFileSync(new URL(file, dir), 'utf8')).vectors;
  const t0 = performance.now();
  const s = await runAll(vectors);
  const ms = (performance.now() - t0).toFixed(0);
  console.log(`${file}: total=${vectors.length} pass=${s.pass} skip=${s.skip} fail=${s.fail} (${ms} ms)`);
  for (const f of s.failures.slice(0, 20)) console.log('  FAIL', f);
  const focus = ['Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s', 'Noise_XX_25519_ChaChaPoly_BLAKE2s', 'Noise_IK_25519_ChaChaPoly_BLAKE2s', 'Noise_KK_25519_ChaChaPoly_BLAKE2s', 'Noise_XXpsk0+psk3_25519_ChaChaPoly_BLAKE2s'];
  for (const name of focus) {
    const vs = vectors.filter((v) => v.protocol_name === name);
    for (const v of vs) console.log(`  ${name}: ${(await runVector(v)).outcome}`);
  }
  if (s.fail > 0) failed = true;
}

// Negative control: corrupt one byte of the XXpsk3 vector's PSK -> must NOT reproduce the ciphertexts.
const cac: Vector[] = JSON.parse(readFileSync(new URL('cacophony.txt', dir), 'utf8')).vectors;
const xx = structuredClone(cac.find((v) => v.protocol_name === 'Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s')!);
xx.init_psks = [xx.init_psks![0].replace(/^../, 'ff')];
xx.resp_psks = [...xx.init_psks];
const neg = await runVector(xx).catch((e) => ({ outcome: 'fail', detail: String(e) }));
console.log(`negative control (tampered PSK on both sides): ${neg.outcome} (${neg.detail}) -- expected fail`);
if (neg.outcome !== 'fail') failed = true;
process.exitCode = failed ? 1 : 0;
```

---

## Verification

Independent verification on 2026-09-27, same machine: Node 25.4.0 and 22.22.1, Chrome 153.0.8010.53 (system), and Playwright 1.63.0 WebKit 26.6 and Firefox 155.0, both downloaded into the verify spike dir. Nothing was installed globally and no home configuration was touched. All browser and key-file experiments used profiles and fake homes inside the verify spike.

Verify spike: `/private/tmp/claude-501/-Users-gcman-Desktop-Project-Smurg/a6b51e5a-83b8-42f3-89ef-f6bb22518fd8/scratchpad/spikes/noise-verify`.

Contents:
- A fresh `npm install` (no lockfile) of the same pinned versions.
- `src/`, `test/` and `browser/` copied from the original spike, plus the verifier's own files:
  - `test/verify.test.ts` (V1–V9)
  - `test/verify-v2.test.ts` and `test/device-key-v2.test.ts`
  - `src/channel-v2.ts` and `src/device-key-v2.ts`
  - `pw/*.mjs`, `eval/clatter-vector.ts`, `keyfile/`, `sea/`
- Re-run everything with `run-verify.sh`.

**Verdict: the recommendation holds**, with the corrections below.

- **Keep:**
  - our own rev-34 state machine on `@noble/*` 2.4.0;
  - `Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s` for first contact, with the `k` fingerprint checked at msg2;
  - `Noise_XX_25519_ChaChaPoly_BLAKE2s` with mutual pinning for reconnect;
  - the invite encoding, trial matching and prologue;
  - the framing;
  - `node:crypto` AEAD on the daemon.
- **Replace:**
  - `device-key.ts` with `device-key-v2.ts`;
  - the handshake drivers and `DaemonPolicy` with `channel-v2.ts`.

### V-A. Confirmed (re-run by the verifier)

| Claim | Verifier evidence |
|---|---|
| Appendix A is the code that ran | Extracted every Appendix A/B block and `diff`ed it against the spike files: all 11 identical. |
| Vector files are the published ones | Re-downloaded `cacophony.txt` and `snow.txt` from GitHub. The sha256 values match the spike (`3bde7c09…`, `69da4333…`). The browser subset equals the 110 `*_25519_ChaChaPoly_BLAKE2s` vectors of both files; the only difference is an extra `_src` field. |
| 1352/1352 vectors, Node 25 and 22 | `cacophony.txt: total=944 pass=944 skip=0 fail=0`, `snow.txt: total=408 pass=408 skip=0 fail=0` on both Node versions. Only **one** exact `Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s` vector exists (cacophony, 6 messages, with handshake hash); snow covers `XXpsk0+psk3` and other psk placements. |
| The vector harness is not vacuous | Mutation test with 6 mutants, each run on the full corpus. All were caught:<br>• drop `MixKey(e)` in psk mode: 336 cacophony failures<br>• swap `es`/`se`: 720<br>• big-endian nonce: 472 + 92<br>• skip prologue: all 1352<br>• `MixKey` instead of `MixKeyAndHash` for psk: 336 + 104<br>• swap the split outputs: all 944 cacophony |
| 23/23 original tests, tsc clean | Node 25.4.0 and 22.22.1: `# pass 23` (44/44 on both Node versions with the verifier's 21 added tests). `tsc -p .` exit 0 with TypeScript 7.0.2. |
| Library rejections | Fresh install of all 8 candidates; `eval-libs.ts` output matches F6–F10. The `@libp2p/noise` grep shows `'Noise_XX_25519_ChaChaPoly_SHA256'` hard-coded twice. `noise-handshake` has only `NNpsk0`/`XXpsk0` in its pattern table. `npm view` publish dates match 1.7. |
| clatterjs (was "not run") | `eval/clatter-vector.ts`: msg0, msg1 and msg2 match, handshake hash matches. Its DH is sync over raw secrets. It stays a runner-up, not a choice. |
| No missed library | `npm search` turned up `@brashkie/signalis-noise` 0.1.0 (SHA-256 only, no psk), `noise-peer`/`simple-handshake` (noise-protocol plus sodium-native), `@node-dlc/noise` (BOLT-8) and `@harrier_/noise-js` (a niomon fork). None fits. |
| Throughput, handshake cost, bundle | Node 25 noble: seal 229 MiB/s, open 220 MiB/s. `node:crypto`: 1372/1611 MiB/s, ciphertexts identical. XXpsk3 handshake: 6.05 ms (Node 25) and 6.21 ms (Node 22). Bundle: 72.6 KiB min / 22.9 KiB gzip. |
| Low-order rejection | noble throws, and Node WebCrypto gives `OperationError`, for u = 0, 1, both order-8 points, p-1 and p. |
| R3 attack tests in three browsers | With the original code, Chrome 153 and Firefox 155 passed:<br>• 110/110 vectors<br>• the invite join over WS<br>• reconnect from IndexedDB<br>• MITM (`daemon-key-mismatch` at msg2)<br>• revoke (`aborted:device-revoked` at msg3)<br>• `markerHits: []` over 29–68 relay frames<br>• fragment stripped<br><br>WebKit 26.6 passed vectors, WebCrypto and the invite join, then failed reconnect. See V-B1. |
| XX over IK (replay) | Test V9: one recorded IK msg1, whose payload `file.write /etc/x` is in the clear only to the daemon, is accepted by two fresh responders. |
| Transport integrity | Test V4: a replayed DATA frame, a frame reflected back to its sender, and a frame from another session each give `authentication tag mismatch`. |
| `node:crypto` daemon suite (recommended but only benchmarked) | Test V5: **676/676** `*_ChaChaPoly_*` vectors through the state machine. Test V6: 0–16 byte and tampered ciphertexts throw; output equals noble. |
| Nonce handling | Test V7: the guard throws at 2^53-1, and `chachaNonce` equals LE64 per the spec up to 2^53-1. |
| Previously unverified, now verified | Node SEA with these deps: runs, 110/110 vectors, mixed noble/`node:crypto` suites. 0600 key files. Full Worker channel in three engines. Firefox and WebKit engines. Node 22 and 25 both have a global `WebSocket`. |

### V-B. Corrected (with evidence)

| # | Original claim | Correction | Evidence |
|---|---|---|---|
| B1 | "Browser, preferred: store the non-extractable `CryptoKeyPair` object in IndexedDB" (1.6, F18, F28) | **Fails in WebKit.** X25519 `CryptoKey`s cannot be structured-cloned. The key must be stored per engine (1.6). | `pw/idb-probe.mjs`, WebKit 26.6: `x25519_nonext: put ok; same-page get -> null`, also after navigation, in a new page, and with a persistent profile. ECDH P-256, Ed25519 and AES-GCM keys round-trip. `pw/msgerr-probe.mjs`: `{"x25519Private":{"ev":"messageerror"},"x25519Public":{"ev":"messageerror"},"ecdhPrivate":{"ev":"message"…}}`. `pw/disk-probe.mjs`: `structuredCloneX25519: "throws TypeError"`. Original e2e in WebKit: phase 2 `"nothing stored in IndexedDB"`. Chrome and Firefox: all fine. |
| B2 | Non-extractable "stops copying the key off the device (dumps, backups)" (1.6) | **Wrong for Chromium and Firefox.** Non-extractable only blocks `exportKey`. The raw key bytes are written to disk in cleartext. | `pw/disk-probe.mjs` imports a *known* X25519 scalar and a known AES key as non-extractable, stores them in IDB, closes the browser and scans the profile. Chrome 153: both found in `Default/IndexedDB/http_127.0.0.1_5188.indexeddb.leveldb/000003.log`. Firefox 155: both found in `storage/default/http+++127.0.0.1+5188/idb/…sqlite`. WebKit: AES key not found (X25519 not storable). |
| B3 | "Expired or used-up invites are rejected" (F19, 1.4) | **Only sequentially.** Concurrent joins both succeed on a 1-use invite, and expiry is checked only at msg1. | Test V1: `fulfilled=4/4 devicesRegistered=2 usesLeft=-1`. Test V8: an invite with 200 ms TTL and msg3 delayed 300 ms is `fulfilled`. The fix (`admit()`) is verified: `v2 RACE fixed` gives exactly `['ok','rejected:invite-exhausted']` and 1 device; `v2 invite that expires…` gives `rejected:invite-expired`. |
| B4 | `checkDevice` on `onRemoteStatic` "may only reject" is safe; ABORT reasons are a product decision (gotchas 1, 5; F17) | **Device-status oracle.** Anyone who knows a device *public* key (and the daemon key, which anyone can learn) can classify it. It also leaks reasons to the relay. | Test V2: probes with only a public key give `unknown -> aborted:device-unknown`, `revoked -> aborted:device-revoked`, `registered -> aborted:handshake-failed`. Fixed in `channel-v2.ts`: `v2 ORACLE closed` gives the same code **and** the same relay-visible frame types and sizes for all three. `v2 revoked device (real key)` gives the authenticated `rejected:device-revoked` with **no ABORT frame** in the relay log. |
| B5 | "The client treats the channel as up only after WELCOME", with the pin persisted afterwards (1.3, browser code) | A lost WELCOME **strands** the joiner: the device is registered and the use consumed, while the client has no pin and the link is exhausted. | Test V3: the relay drops the WELCOME and forges an ABORT. The daemon `fulfilled` and `usesLeft=0`; the client gets `aborted:handshake-failed`; a retry gets `aborted:invite-exhausted`. A device-mode reconnect with the daemon key would work. Fixed with `onDaemonVerified`: `v2 lost WELCOME` recovers. |
| B6 | Gotcha 11: `node:crypto` "must set" `authTagLength` and `plaintextLength` | Both are optional for chacha20-poly1305. The tag defaults to 16 bytes. | Test V6: no options still gives noble-identical output. |
| B7 | Gotcha 9 / F27: WebCrypto rejects low-order keys with `OperationError` | In Firefox 155 the error is `DataError`. | Original e2e in Firefox: `"lowOrder":"rejected: DataError"`. |
| B8 | Browser throughput "about 200 MiB/s" | Chrome 219/219 MiB/s and WebKit 207/202, but **Firefox 132/135 MiB/s**. | `pw/drive.mjs`, `throughput8MiB`. |
| B9 | clatterjs "not run" (1.7) | It **passes** the XXpsk3 vector. It is still rejected (sync DH over raw secrets, single release). | `eval/clatter-vector.ts`. |
| B10 | Audit list (1.7) | X25519 (`montgomery`) is only in scope for Cure53 1.6.0 and Trail of Bits 2.3.0, not for Kudelski or Trail of Bits 0.7.3. | `@noble/curves` README lines 569–590. |

### V-C. Corrected module files (verbatim from the verify spike; all tests above ran against them)

Tests: `test/verify-v2.test.ts` (8 tests) and `test/device-key-v2.test.ts` (4 tests) pass on Node 25.4.0 and 22.22.1. The browser end-to-end run `pw/drive-v2.mjs` passed in Chrome 153, WebKit 26.6 and Firefox 155. Chrome and Firefox chose `webcrypto`; WebKit chose `wrapped`. Each engine passed these phases:

- invite join
- reload and reconnect
- Worker: IndexedDB, handshake and 8 MiB echo
- MITM, giving `daemon-key-mismatch` at 2
- revoke, giving a rejection at 3
- `markerHits: []`

Exports of the in-use key were rejected with `InvalidAccessError`. `pw/xss-unwrap.mjs` shows the documented weakness of `wrapped`: same-origin script can `unwrapKey(…, extractable=true)` and export 48 bytes of PKCS#8.

Wire changes relative to 1.3:
- ABORT is always `[0x7f,0x00]`.
- The first DATA message from the daemon is `[0x00][welcome]` or `[0x01][reason]`.
- The client error codes are `aborted` (pre-auth, generic) and `rejected:<reason>` (post-auth, authenticated).

`DaemonPolicy` changes from `{invites, checkDevice, onAccepted}` to `{invites, admit}`.

#### `src/channel-v2.ts`

```ts
// VERIFIER'S CORRECTED handshake drivers (drop-in successor of src/channel.ts; same wire frames and Noise patterns).
// Fixes found during verification:
//  (1) Invite-use race (TOCTOU): the use count was checked at msg1 and decremented in onAccepted, which could not
//      reject. Now ONE synchronous `admit()` runs after msg3 is authenticated and must check-and-consume atomically.
//  (2) Pre-auth status oracle: checkDevice() ran on the UNAUTHENTICATED msg3 static key and the reason went out as a
//      cleartext ABORT, so anyone knowing only a device public key learned unknown/registered/revoked. Now every
//      pre-auth failure yields the same generic cleartext ABORT, and post-auth verdicts travel ENCRYPTED.
//  (3) Relay-visible reasons: post-auth rejections (revoked, unknown device, expired/exhausted invite) are sent as an
//      encrypted first DATA message, so the relay sees neither the reason nor (by frame type) accept vs reject.
//  (4) Lost WELCOME: the client can persist the verified daemon key (onDaemonVerified) before sending msg3, so a
//      join whose WELCOME never arrives can be recovered with a device-mode reconnect instead of a new invite.
import { HandshakeState, NoiseError, resolvePattern } from './noise.ts';
import { Noise_25519_ChaChaPoly_BLAKE2s, type KeyPair, type Suite } from './suite.ts';
import { FRAME, Opener, Sealer } from './framing.ts';
import { MODE, buildPrologue, daemonFingerprint, deriveInvite, type Mode } from './invite.ts';
import { EMPTY, concat, equalBytes } from './bytes.ts';
import { ChannelError, SecureChannel, type FrameIO } from './channel.ts';

export { ChannelError, SecureChannel, type FrameIO };

/** Post-auth verdicts (only ever sent encrypted). */
export const REJECT = { 'invite-expired': 1, 'invite-exhausted': 2, 'device-unknown': 3, 'device-revoked': 4, 'not-allowed': 5 } as const;
export type RejectReason = keyof typeof REJECT;
const REJECT_BY_CODE = Object.fromEntries(Object.entries(REJECT).map(([k, v]) => [v, k])) as Record<number, RejectReason>;
/** The only cleartext ABORT the daemon sends before authentication. */
const GENERIC_ABORT = new Uint8Array([FRAME.ABORT, 0]);
const VERDICT_OK = 0x00;
const VERDICT_REJECT = 0x01;

function channelFrom(hs: HandshakeState): SecureChannel {
  const t = hs.split();
  return new SecureChannel(new Sealer(t.send), new Opener(t.recv), t.handshakeHash, t.remoteStatic!);
}

async function expect(io: FrameIO, type: number, at: number): Promise<Uint8Array> {
  const f = await io.recv();
  if (f[0] === FRAME.ABORT) throw new ChannelError('aborted', 'peer aborted the handshake', at);
  if (f[0] !== type) throw new ChannelError('protocol', `expected frame ${type}, got ${f[0]}`, at);
  return f.subarray(1);
}

// ------------------------------------------------------------------ client
export type ClientTrust = { kind: 'invite'; fingerprint: Uint8Array; secret: Uint8Array } | { kind: 'pinned'; daemonKey: Uint8Array };

export interface ClientOptions {
  workspaceId: string;
  deviceKey: KeyPair;
  trust: ClientTrust;
  hello?: Uint8Array;
  /** Runs after msg2 proved the daemon key (fingerprint/pin + es), BEFORE msg3 is sent. Persist the pin here. */
  onDaemonVerified?: (daemonKey: Uint8Array) => void | Promise<void>;
  suite?: Suite;
  /** TEST ONLY */
  _pskOverride?: Uint8Array;
}

export async function clientConnect(io: FrameIO, o: ClientOptions): Promise<{ channel: SecureChannel; daemonKey: Uint8Array; welcome: Uint8Array }> {
  const invite = o.trust.kind === 'invite' ? deriveInvite(o.trust.secret) : null;
  const mode: Mode = invite ? MODE.INVITE : MODE.DEVICE;
  const hs = new HandshakeState({
    suite: o.suite ?? Noise_25519_ChaChaPoly_BLAKE2s,
    pattern: resolvePattern(invite ? 'XXpsk3' : 'XX'),
    initiator: true,
    prologue: buildPrologue(o.workspaceId, mode, invite?.inviteId),
    s: o.deviceKey,
    psks: invite ? [o._pskOverride ?? invite.psk] : [],
  });
  await io.send(concat(new Uint8Array([FRAME.HELLO, 1, mode]), await hs.writeMessage()));
  const msg2 = await expect(io, FRAME.REPLY, 2);
  try {
    await hs.readMessage(msg2, (rs) => {
      const ok = o.trust.kind === 'invite' ? equalBytes(daemonFingerprint(rs), o.trust.fingerprint) : equalBytes(rs, o.trust.daemonKey);
      if (!ok) throw new ChannelError('daemon-key-mismatch', 'daemon static key does not match the invite fingerprint / pinned key', 2);
    });
  } catch (e) {
    await io.send(GENERIC_ABORT);
    if (e instanceof ChannelError) throw e;
    throw new ChannelError('handshake-failed', `msg2 rejected: ${(e as Error).message}`, 2);
  }
  // msg2 payload decrypted => es mixed => daemon proved possession of the verified static key.
  await o.onDaemonVerified?.(hs.remoteStatic!);
  await io.send(concat(new Uint8Array([FRAME.FINISH]), await hs.writeMessage(o.hello ?? EMPTY)));
  const channel = channelFrom(hs);
  const first = await io.recv();
  if (first[0] === FRAME.ABORT) throw new ChannelError('aborted', 'daemon could not authenticate msg3 (wrong PSK or not the device key owner)', 3);
  const [verdict] = channel.open(first);
  if (!verdict || verdict.length < 1) throw new ChannelError('protocol', 'missing verdict', 3);
  if (verdict[0] === VERDICT_REJECT) {
    const reason = REJECT_BY_CODE[verdict[1]] ?? 'not-allowed';
    throw new ChannelError(`rejected:${reason}`, `daemon rejected this device: ${reason}`, 3); // authenticated reason
  }
  if (verdict[0] !== VERDICT_OK) throw new ChannelError('protocol', 'bad verdict', 3);
  return { channel, daemonKey: hs.remoteStatic!, welcome: verdict.subarray(1) };
}

// ------------------------------------------------------------------ daemon
export interface InviteKey {
  inviteId: Uint8Array;
  psk: Uint8Array;
}

export interface AdmitInfo {
  mode: Mode;
  devicePub: Uint8Array;
  inviteId?: Uint8Array;
  hello: Uint8Array;
}

export interface DaemonPolicy {
  /** Every invite still on file (incl. recently expired / used up, so the verdict can be precise). */
  invites(): Iterable<InviteKey>;
  /**
   * Runs exactly once, right after msg3 is AUTHENTICATED (PSK + device key possession proven).
   * MUST be synchronous and must check AND consume in one step (expiry, uses left, device revoked/unknown,
   * then decrement uses / register device). No await in here, or two joins can race again.
   */
  admit(info: AdmitInfo): 'ok' | RejectReason;
}

export interface DaemonOptions {
  workspaceId: string;
  staticKey: KeyPair;
  policy: DaemonPolicy;
  welcome: (info: AdmitInfo) => Uint8Array;
  suite?: Suite;
}

export async function daemonAccept(io: FrameIO, o: DaemonOptions) {
  const suite = o.suite ?? Noise_25519_ChaChaPoly_BLAKE2s;
  const responder = (mode: Mode, inv?: InviteKey) =>
    new HandshakeState({ suite, pattern: resolvePattern(inv ? 'XXpsk3' : 'XX'), initiator: false, prologue: buildPrologue(o.workspaceId, mode, inv?.inviteId), s: o.staticKey, psks: inv ? [inv.psk] : [] });
  let stage = 1;
  let hs: HandshakeState | undefined;
  let invite: InviteKey | undefined;
  try {
    const hello = await expect(io, FRAME.HELLO, 1);
    const [ver, rawMode] = hello;
    if (ver !== 1 || (rawMode !== MODE.INVITE && rawMode !== MODE.DEVICE)) throw new ChannelError('bad-hello', 'unsupported version/mode', 1);
    const mode = rawMode as Mode;
    const msg1 = hello.subarray(2);
    if (mode === MODE.INVITE) {
      for (const inv of o.policy.invites()) {
        const cand = responder(mode, inv);
        try {
          await cand.readMessage(msg1);
        } catch {
          continue;
        }
        hs = cand;
        invite = inv;
        break;
      }
      if (!hs) throw new ChannelError('invite-unknown', 'no invite matches msg1', 1);
    } else {
      hs = responder(mode);
      await hs.readMessage(msg1);
    }
    await io.send(concat(new Uint8Array([FRAME.REPLY]), await hs.writeMessage()));
    stage = 3;
    const msg3 = await expect(io, FRAME.FINISH, 3);
    const clientHello = await hs.readMessage(msg3); // no pre-auth hook: nothing is decided on an unauthenticated key
    stage = 4;
    const info: AdmitInfo = { mode, devicePub: hs.remoteStatic!, inviteId: invite?.inviteId, hello: clientHello };
    const channel = channelFrom(hs);
    const verdict = o.policy.admit(info); // synchronous check-and-consume
    if (verdict !== 'ok') {
      await io.send(channel.seal(new Uint8Array([VERDICT_REJECT, REJECT[verdict]])));
      throw new ChannelError(verdict, `admission refused: ${verdict}`, 3);
    }
    await io.send(channel.seal(concat(new Uint8Array([VERDICT_OK]), o.welcome(info))));
    return { channel, ...info };
  } catch (e) {
    if (stage < 4) await io.send(GENERIC_ABORT); // same bytes for every pre-auth failure
    if (e instanceof ChannelError) throw e;
    const detail = e instanceof NoiseError ? e.code : String(e);
    throw new ChannelError('handshake-failed', `msg${stage} rejected: ${detail}`, stage);
  }
}
```

#### `src/device-key-v2.ts`

```ts
// VERIFIER'S CORRECTED device-key storage (replaces src/device-key.ts).
//
// Measured (Chrome 153, Playwright Firefox 155, Playwright WebKit 26.6):
//  * Chromium/Firefox: a non-extractable X25519 CryptoKeyPair survives IndexedDB and postMessage.
//  * WebKit: X25519 CryptoKeys cannot be structured-cloned at all: structuredClone() throws TypeError,
//    IndexedDB get() returns null, postMessage fires `messageerror`. (ECDH P-256, Ed25519, AES keys clone fine.)
//  * At rest: Chromium and Firefox write the raw bytes of NON-extractable keys into the IndexedDB files in
//    cleartext; WebKit did not (AES key bytes not found on disk). Non-extractable only stops JS from EXPORTING.
//
// Therefore:
//  kind 'webcrypto' : non-extractable X25519 CryptoKeyPair stored as-is (when structuredClone works).
//                     Same-origin script can USE but never EXPORT the key.
//  kind 'wrapped'   : (WebKit) non-extractable AES-GCM kek (clones fine) + wrapKey('pkcs8') ciphertext;
//                     unwrapKey(..., extractable=false) gives a non-extractable X25519 key for DH.
//                     Weaker vs XSS: same-origin script could unwrap with extractable=true and export.
//  kind 'raw'       : no WebCrypto X25519 at all: noble secret bytes in IndexedDB.
import { x25519 } from '@noble/curves/ed25519.js';
import { equalBytes } from './bytes.ts';
import { webCryptoX25519KeyPair, x25519KeyPair, type KeyPair } from './suite.ts';

export type DeviceKeyRecord =
  | { kind: 'webcrypto'; pair: CryptoKeyPair }
  | { kind: 'wrapped'; kek: CryptoKey; iv: Uint8Array; wrapped: Uint8Array; publicKey: Uint8Array }
  | { kind: 'raw'; secretKey: Uint8Array };

async function selfTest(kp: KeyPair): Promise<void> {
  const probe = x25519.utils.randomSecretKey();
  if (!equalBytes(await kp.dh(x25519.getPublicKey(probe)), x25519.getSharedSecret(probe, kp.publicKey))) throw new Error('X25519 self-test failed');
}

function cloneable(v: unknown): boolean {
  try {
    return structuredClone(v) != null;
  } catch {
    return false;
  }
}

export async function createDeviceKeyRecord(subtle: SubtleCrypto = globalThis.crypto.subtle, opts: { forceWrapped?: boolean } = {}): Promise<DeviceKeyRecord> {
  try {
    const pair = (await subtle.generateKey({ name: 'X25519' }, false, ['deriveBits'])) as CryptoKeyPair;
    await selfTest(await webCryptoX25519KeyPair(pair, subtle));
    if (!opts.forceWrapped && cloneable(pair)) return { kind: 'webcrypto', pair };
    // X25519 works but cannot be persisted as a CryptoKey (WebKit): wrap it.
    const kek = (await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey'])) as CryptoKey;
    const tmp = (await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const wrapped = new Uint8Array(await subtle.wrapKey('pkcs8', tmp.privateKey, kek, { name: 'AES-GCM', iv }));
    const publicKey = new Uint8Array(await subtle.exportKey('raw', tmp.publicKey));
    const rec: DeviceKeyRecord = { kind: 'wrapped', kek, iv, wrapped, publicKey };
    await selfTest(await keyPairFromRecord(rec, subtle));
    return rec;
  } catch {
    return { kind: 'raw', secretKey: x25519.utils.randomSecretKey() };
  }
}

/** Call on the value read back from IndexedDB (a platform that failed to clone a CryptoKey yields null inside). */
export function isUsableRecord(r: unknown): r is DeviceKeyRecord {
  const x = r as DeviceKeyRecord | null | undefined;
  if (!x) return false;
  const isKey = (k: unknown) => typeof CryptoKey !== 'undefined' && k instanceof CryptoKey;
  if (x.kind === 'raw') return x.secretKey instanceof Uint8Array && x.secretKey.length === 32;
  if (x.kind === 'webcrypto') return !!x.pair && isKey(x.pair.privateKey) && isKey(x.pair.publicKey);
  return x.kind === 'wrapped' && isKey(x.kek) && x.wrapped instanceof Uint8Array && x.publicKey?.length === 32;
}

export async function keyPairFromRecord(r: DeviceKeyRecord, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<KeyPair & { privateExtractable?: boolean }> {
  if (r.kind === 'raw') return x25519KeyPair(r.secretKey);
  if (r.kind === 'webcrypto') return { ...(await webCryptoX25519KeyPair(r.pair, subtle)), privateExtractable: r.pair.privateKey.extractable };
  const priv = await subtle.unwrapKey('pkcs8', r.wrapped as Uint8Array<ArrayBuffer>, r.kek, { name: 'AES-GCM', iv: r.iv as Uint8Array<ArrayBuffer> }, { name: 'X25519' }, false, ['deriveBits']);
  return {
    publicKey: r.publicKey,
    privateExtractable: priv.extractable,
    async dh(remotePublic: Uint8Array): Promise<Uint8Array> {
      const remote = await subtle.importKey('raw', remotePublic as Uint8Array<ArrayBuffer>, { name: 'X25519' }, true, []);
      return new Uint8Array(await subtle.deriveBits({ name: 'X25519', public: remote }, priv, 256));
    },
  };
}
```

### V-D. Still unverified

- **The real Safari 26.5 app and iOS Safari.** WebKit 26.6 (Playwright) is strong evidence that Safari cannot clone X25519 CryptoKeys either, but Safari itself was not run, because remote automation is a system setting we must not change. The design does not depend on this: the `structuredClone` probe picks `webcrypto` or `wrapped` at runtime, and `isUsableRecord` re-checks after every read. Also unverified in Safari: its at-rest wrapping of stored CryptoKeys.
- **Stock Firefox and Chrome release channels.** Firefox was Playwright's Juggler build 155.0, and Chrome was the system Chrome 153 headless.
- **The Cloudflare Workers / Durable Objects relay**: ordering, the 32 MiB limit, Hibernation with binary frames, real latency. This belongs to the relay spike.
- **Third-party audits** of noise-handshake, salty-crypto and clatterjs, and the contents of the noble audit reports (only the README claims were checked).
- **Identity binding** of the device key to the OAuth account. Still a design decision.
- **Node 22.18.0 to 22.22.0.** Only 22.22.1 and 25.4.0 were run.
- **Relay inference of accept vs reject** from the verdict size and the connection close. The fix hides the reason, not the outcome. Padding is untested.
