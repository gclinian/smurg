# Developing smurg

For people who work on smurg itself: building it from source, the layout of the repository, the checks, the local
stack, packaging and releasing, and where every document is. What a change must respect is in
[`CONTRIBUTING.md`](../CONTRIBUTING.md). To use smurg, start from the [`README`](../README.md) and the
[quick start](QUICKSTART.md) instead.

## Developing from source

You need macOS or Linux, [Node.js](https://nodejs.org/) 22 LTS (22.18 or later) or 24 LTS, and git. nvm is the
easiest way to install Node (`nvm install 22`); Node 25 is outside vitest's supported range and is not supported. To
run real agents you also need the `claude` command (2.1.288 or later); the tests do not need it, and neither does
the local stack when it is started with `--stand-in-claude` (both use a scripted stand-in, see "Checks and common
commands" and "Local development").

```sh
git clone https://github.com/gclinian/smurg.git && cd smurg
scripts/bootstrap-tools.sh                      # once: installs the pinned pnpm into .tools/ (nothing global)
source scripts/env.sh                           # in every new shell (bash and zsh both work)
scripts/with-install-lock.sh pnpm install       # installs the dependencies (about 1 GB on disk, all inside the repo)
scripts/dev-stack.sh --stand-in-claude --role agent   # starts the whole system on this computer to try it (no account needed: its agents are a scripted stand-in); Ctrl-C stops everything
```

`scripts/env.sh` puts Node 22 and the repository's pnpm first in `PATH`, keeps the tools' state inside the repository
(`XDG_CONFIG_HOME=.xdg`, the pnpm store in `.tools/`, `WRANGLER_SEND_METRICS=false`, `CI=true`) and sets
`SMURG_NO_BROWSER=1`: a `smurg` run from this shell never opens your browser (see "Keeping smurg from opening a
browser"). It fails with a message when it finds no supported Node. Add a new dependency to the `package.json` of
your own package (with an exact version), then run `scripts/with-install-lock.sh pnpm install`. To run the CLI from
source: `node packages/cli/src/main.ts <command>` (or, in this terminal,
`alias smurg="node $SMURG_ROOT/packages/cli/src/main.ts"`; `scripts/env.sh` sets `SMURG_ROOT`).

Before you change code, read [`CONTRIBUTING.md`](../CONTRIBUTING.md) and the rules in
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md) §0. Every text smurg shows is written in English first and has a
Traditional Chinese counterpart; the terms are in [`docs/GLOSSARY.md`](GLOSSARY.md).

## Layout

```
apps/
  web/         React + Vite front end (the sessions view and code mode; Monaco, Yjs, xterm.js)
  relay/       Cloudflare Worker + Durable Objects (WorkspaceDO, TransferDO, DeviceLoginDO); it also serves the front end (app.smurg.ai)
  site/        the product page smurg.ai (static pages, plus a small Worker for redirects such as /install.sh)
packages/
  protocol/    message schemas (zod), constants, roles, the Noise encrypted channel, the relay's control frames and routes, the shared message catalog
  daemon/      the host's daemon (files, documents, file locks, terminal and agent sessions, conversations, topics, inbox, worktrees, hooks)
  cli/         the `smurg` command
tests/
  e2e/         acceptance tests across packages (a real relay + daemon + headless clients)
  lint/        repository-wide checks: the language rules, the two languages in step, what the documents quote and name
scripts/       development environment, the single executable, release files and the install script
docs/          guides, architecture and research reports
```

Every package is "source first": `exports` points straight at the `.ts` sources, so developing and testing need no
build step (Node ≥ 22.18 runs TypeScript directly).

## Checks and common commands

```sh
pnpm check                                  # type check + tests of every package (run it before you commit)
pnpm typecheck                              # only the type check (TypeScript 7)
pnpm test                                   # only the tests (vitest: one project per package, plus apps/web/e2e/smoke and tests/lint)
pnpm --filter @smurg/protocol test          # one package only
pnpm build                                  # builds the front end (Vite) and the relay (wrangler dry-run)
pnpm dev:relay                              # the relay's dev server http://127.0.0.1:8787 (local workerd, no Cloudflare account)
pnpm dev:web                                # the front end's dev server http://localhost:5173 (/auth /api /ws /xfer go to the relay)
node packages/cli/src/main.ts --version     # runs the CLI straight from source
```

The tests never reach a network beyond 127.0.0.1 and never use a real account or credential. Agent sessions in the
tests are driven by a stand-in for `claude` that follows a scripted scenario
(`packages/daemon/src/testing/fake-claude.mjs`); the tests that run the real `claude` binary do so only against the
repository's fake Anthropic API with a dummy key and an isolated configuration folder.

**The gate**: `source scripts/env.sh && pnpm check`; do not change `TMPDIR`, and run only one at a time. The number
of test files and tests a green run shows, how long it takes and the environments it was verified in are in
[`docs/ACCEPTANCE.md`](ACCEPTANCE.md), "How to run the gate" (the numbers change as features are added and are
recorded only there). Skipped by default: `packages/cli/test/sea.test.ts`, `packages/cli/test/sea-update.test.ts` and
`packages/cli/test/sea-git-while-sharing.test.ts` (they need the single executable to be built first,
`SMURG_SEA_BINARY`), `packages/cli/test/sea-upgrade.test.ts`
(it also needs the executables of the published versions, `SMURG_PREVIOUS_BINARIES`; it says on stderr that it was
skipped, and a release's gate, `SMURG_RELEASE_GATE=1`, fails without it: `docs/RELEASING.md` §4.5) and the test of
`packages/cli/test/dev-stack.test.ts` that starts the whole stack (`SMURG_TEST_DEV_STACK=1`; the file's other test
always runs); without a system Chrome or a verified version of `claude`, the tests that need them are skipped too,
and the numbers differ. Temporary directories and processes that a test did not clean up (a crashed
worker, for example) are removed after the whole run, with a line on stderr,
`[smurg test run] removed N leftover(s)`: a green run does not print it, so when it appears, find the test that left
them.

## Local development

One command starts the whole system on this computer (the relay, the web dev server, and `smurg host` sharing a
sample folder), with no account:

```sh
scripts/dev-stack.sh --stand-in-claude      # sources scripts/env.sh by itself; Ctrl-C stops everything
scripts/dev-stack.sh --help                 # options: --dir, --relay-port, --web-port, --host-user, --role, --stand-in-claude, --real-claude
```

Which Claude Code the stack's agent sessions run is yours to say:

- `scripts/dev-stack.sh --stand-in-claude` runs the stack's agent sessions on a scripted stand-in for Claude Code
  (no account, no network, nothing is billed; it follows `<dir>/stand-in-claude/fake-claude-scenario.json`, read
  again at every turn: send `try write`, `try run` or `try ask` to see an edit, a command or a question).
- `scripts/dev-stack.sh --real-claude` runs them on the Claude Code installed on this computer, with the login it
  finds: your own account, and what an agent does may be billed to it.
- With neither switch: when there is no `claude` on `PATH`, an agent session answers that Claude Code was not found
  (terminals, files and everything else work). When there is one, the script says plainly, before it starts
  anything and again in its summary, that agent sessions run the REAL Claude Code with your login; and when it is
  not run from a terminal (a script, a test, an agent) it starts nothing, exits with 2 and names the two switches.
  Automated runs always pass `--stand-in-claude`.

What it does, in order:

1. Starts the relay (`pnpm run dev` in `apps/relay`, with the development login on) at `http://localhost:8787`,
   and the web dev server (Vite) at `http://localhost:5173` (`/auth /api /ws /xfer` go to the relay). When you change
   a port, the relay's `RELAY_ISSUER` and `ALLOWED_ORIGINS` and Vite's proxy target follow. The output of the relay
   and of Vite is written to `<dir>/logs/`.
2. Creates a sample project in `<dir>/project` (a git repository when git is installed), logs in as `dev:host` with
   the development login, `smurg login --relay http://localhost:8787 --dev-user host`, and runs
   `smurg host <dir>/project --relay http://localhost:8787 --web-origin http://localhost:5173 --role editor --no-keep-awake`
   (a development setup does not keep the computer awake; `--role` comes from dev-stack's `--role`).
3. Prints the host's own link and the invite link for teammates (`http://localhost:5173/join/…#k=…&s=…`, only in the
   terminal). Open the host's link in a browser and enter `host` as the account name of the development login;
   open the invite link in another browser profile or a private window and join under another name (`amy`, for
   example). **The address must use `localhost`**, not `127.0.0.1`: the relay's cookie and its Origin check go by
   `localhost`. A teammate can join with the CLI too, and dev-stack prints the full commands (the teammate gets a
   fake `HOME` / `SMURG_HOME` of their own): `smurg login --no-browser --dev-user amy --relay http://localhost:8787`,
   then `smurg attach --invite - --relay http://localhost:8787` (paste the invite link when it asks). The invite link
   points at the web origin (:5173) while the CLI has to connect to the relay directly (:8787): logins are recorded
   per address, so without `--relay` the CLI asks for a separate login to :5173 and suggests `--relay`.
4. On Ctrl-C: first lets `smurg host` stop properly (drops every connection, ends the terminal sessions, pauses the
   agent sessions), then stops the web server and the relay, and waits until every process group it started is empty
   (a grandchild of pnpm can take a moment longer than its parent). Every child runs in its own process group, and
   the script only signals the process groups it started and recorded itself.

`<dir>` defaults to `$TMPDIR/smurg-dev-stack`. `smurg` uses a fake `HOME` (`<dir>/home`) and its own `SMURG_HOME`
there, so it never touches your `~/.smurg`, `~/.claude` or shell startup files; when the path of `SMURG_HOME` is too
long for a Unix socket (104 bytes on macOS), it uses `/tmp/smurg-dev-<uid>-<hash>` instead. In its summary the
script also prints the command that attaches the host to a terminal session on this computer
(`HOME=… SMURG_HOME=… node packages/cli/src/main.ts attach`).

### Keeping smurg from opening a browser

Without a relay login, `smurg login`, `smurg host` and `smurg attach` log in with a code and, on a computer with a
desktop, open the relay's `/device` page. In automated runs, tests, reviews, over SSH or without a terminal, **the
CLI never opens a browser by itself** and only prints the address and the code: `SMURG_NO_BROWSER=1` (which
`scripts/env.sh` sets), `CI`, `SSH_CONNECTION`, standard input or output that is not a terminal, or Linux without a
display: any one of these is enough. Every command that logs in also has `--no-browser`. In automation, always log
in first with `smurg login --no-browser --dev-user <name> --relay <the address the next command will use>`. When you
really want the CLI to open a browser to log in to a real relay, set `SMURG_NO_BROWSER=0 CI=false` for that one
command.

## The `smurg` command

`smurg <command> --help` prints every option of a command, and the [`README`](../README.md#documentation) lists the
commands, one line each.

The relay is chosen in this order: `--relay`, the environment variable `SMURG_RELAY_URL`, the relay you last logged
in to, and only then the built-in shared relay https://app.smurg.ai (`smurg attach` first uses the address in the
invite link, or the relay it used the last time it joined that workspace). All state is in `SMURG_HOME` (default
`~/.smurg`). When you develop or test in this repository, always set `SMURG_HOME` and a fake `HOME`, and connect to
the local relay with `--relay http://localhost:8787`. The CLI's language follows the locale; tests pin it with
`SMURG_LANG=en`.

## Packaging and releasing

The single executable (Node SEA, with native modules such as node-pty inside):
`scripts/build-sea.sh [--node <node>] [--version X.Y.Z] [--target <platform>-<arch>]` (documented at the top of
`scripts/build-sea.ts`). It builds `packages/cli/dist/smurg-<platform>-<arch>` for this computer's platform, then
runs the smoke tests `packages/cli/test/sea.test.ts` and `sea-update.test.ts`; without `--version` the version is
`<package version>-dev`. The first time the executable needs its native modules (`smurg host`), it unpacks them into
the cache directory `~/Library/Caches/smurg/native-<id>` (Linux: `$XDG_CACHE_HOME/smurg`) and checks them with sha256
at every start; `SMURG_CACHE_DIR` changes the place; another version's directory is deleted after 30 days without
use.

Releases are built by GitHub Actions when a `v*` tag is pushed (`.github/workflows/release.yml`): one build per
platform, four in all, each smoke-tested, after which `scripts/release-assets.sh` produces `SHA256SUMS`,
`install.sh` and `THIRD-PARTY-NOTICES.txt`. The executables are published at https://downloads.smurg.ai (Cloudflare
R2; `v<version>/` and `latest/`), uploaded by a maintainer after checking them on their own computer (not by CI);
the GitHub release carries the release notes, `SHA256SUMS` and the notices. Pushes to `main` and pull requests run
`pnpm check` on macOS and Ubuntu (`.github/workflows/ci.yml`). A maintainer deploys the shared relay to the
Cloudflare Workers custom domain app.smurg.ai with `scripts/deploy-relay.sh` (again from the release's commit before
every release), and smurg.ai (`apps/site`, with https://smurg.ai/docs/ and https://smurg.ai/license/) as well. The
steps are in [`docs/RELEASING.md`](RELEASING.md); each version's changes are in [`CHANGELOG.md`](../CHANGELOG.md).

## Third-party notices

The third-party software in the executables and the web app keeps its own licenses: the lists and the full license
texts are [`packages/cli/THIRD-PARTY-NOTICES.txt`](../packages/cli/THIRD-PARTY-NOTICES.txt) (the executable; the
version `smurg licenses` prints also has the Node.js license) and
[`apps/web/public/third-party-notices.txt`](../apps/web/public/third-party-notices.txt) (the web app,
https://app.smurg.ai/third-party-notices.txt). `node scripts/third-party-notices.ts` generates both files from
`pnpm-lock.yaml` and the installed packages; do not edit them by hand: regenerate and commit them when the
dependencies change (`pnpm check`, `scripts/build-sea.sh` and the web build all refuse stale files).

## The README's picture

The moving picture at the top of the two READMEs is an illustration, drawn by a script: four SVG files in
[`.github/assets/`](../.github/assets/) (light and dark, English and Traditional Chinese). It tells the story of
the product page's own picture (`apps/site/public/index.html`) with that page's words and colours.

```sh
node scripts/readme-picture.ts              # writes the four pictures again
node scripts/readme-picture.ts --measure    # first, after changing a word or a text size (headless Chrome on macOS)
node scripts/readme-picture.ts --sheet DIR  # to look at a change: every picture held at twelve moments, in DIR/index.html
```

Run it whenever the product page's picture changes its scenes, its words or its colours, and commit the pictures:
`tests/lint/readme-picture.test.ts` fails until they are what the script writes, and holds every word of a picture to
the page of its language. What no test can hold is that the two drawings still tell the same story: when a scene of
the page changes, change the drawing in `scripts/readme-picture.ts` to match and look at the sheet. Nor does a test
open the file in a browser: the script measures and the sheet is looked at in Chrome, so after a change to how the
picture moves or to its two drawings, push the branch and look at its page on github.com in Safari, in Firefox and
in the GitHub phone app, light and dark (it moves, a phone shows the simpler drawing, dark shows the dark file). The
head of that script says how the pictures are built and why. `tests/lint/readme.test.ts` holds the READMEs
themselves: the head, the honest lines, the two languages in step, and every relative link.

## Documents

| Document | What is in it |
|---|---|
| [`docs/QUICKSTART.md`](QUICKSTART.md) ([繁體中文](zh-TW/QUICKSTART.md)) | The quick start: from installing to a first topic that is reviewed and merged |
| [`docs/HOSTING.md`](HOSTING.md) ([繁體中文](zh-TW/HOSTING.md)) | Host guide: installing, logging in, the shared relay and your own, sharing, what to know before you share, the Agent access role and its risk, what agents may do and your own Claude Code settings, stopping, troubleshooting, updating and uninstalling, topics from the host's side |
| [`docs/JOINING.md`](JOINING.md) ([繁體中文](zh-TW/JOINING.md)) | Guide for teammates, also for people new to smurg and Claude Code: roles, the inbox, talking to agents, topics from discussion to reviewed result |
| [`CHANGELOG.md`](../CHANGELOG.md) ([繁體中文](zh-TW/CHANGELOG.md)) | What changed in each version |
| [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) | The contracts between the packages (read the rules in §0 before you write code), where smurg deliberately differs from SPEC (§11), known limits (§12) |
| [`docs/GLOSSARY.md`](GLOSSARY.md) | The terms smurg uses, in English and Traditional Chinese, and the style of its texts |
| [`docs/ACCEPTANCE.md`](ACCEPTANCE.md) | Every acceptance criterion, its automated tests and its state |
| [`docs/RELEASING.md`](RELEASING.md) | For maintainers: deploying the shared relay, releasing a version, deploying smurg.ai, rolling back |
| [`SPEC.md`](../SPEC.md), [`docs/research/`](research/) | The original requirements (Traditional Chinese); the technical checks done before the code was written |
| [`docs/design/v0.5.0/`](design/v0.5.0/) | The design of the topics flow as it was written: the owner's brief and decisions, the design, the interface and its mock |
| [`apps/relay/README.md`](../apps/relay/README.md) | The relay: routes, configuration, deploying it, running your own |
| [`apps/site/README.md`](../apps/site/README.md) | smurg.ai: content, redirects and deploying |
| [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`SECURITY.md`](../SECURITY.md) | How to contribute; how to report a vulnerability |
