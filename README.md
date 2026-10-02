English | [繁體中文](README.zh-TW.md)

# smurg

[![CI](https://github.com/gclinian/smurg/actions/workflows/ci.yml/badge.svg)](https://github.com/gclinian/smurg/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

smurg is a real-time workspace for several people and several agents: you run `smurg host` on your own computer to
share a project folder, your teammates open the invite link you send them, and you all edit the files together in a
browser. Everyone also sees, live, what every Claude Code session is doing and can send it suggestions; teammates you
fully trust (the Agent access role) can open agents on your computer too. The files and the agents stay on your
computer, and the relay that forwards the data in between sees only end-to-end encrypted data. Product page:
https://smurg.ai; documentation: https://smurg.ai/docs/; web app (the shared relay): https://app.smurg.ai.

> **Status: prototype.** Developed and tested on macOS (Apple silicon); for other platforms and real accounts, see
> "Not verified yet, and known limits" below. You are welcome to try it, but do not share a folder that holds
> passwords, keys or personal data ([`docs/HOSTING.md`](docs/HOSTING.md) §4).

## What it can do

- The host shares a folder with one command, which prints an invite link; teammates join with the link as a Viewer,
  an Editor or with Agent access.
- A file tree and an editor in the browser: several people edit together in real time, with automatic saving;
  drag-and-drop uploads (resumable after a dropped connection), and downloads of a file or a whole folder (zip).
- Real Claude Code on the host's computer. The host and teammates with agent access can open agent and terminal
  sessions and type into any session; these sessions all run **as the host** (the host's Claude Code login, the
  host's computer, no sandbox), so this role is only for people the host fully trusts
  ([`docs/HOSTING.md`](docs/HOSTING.md) §5.1). Everyone sees every session live and can attach one to their own
  terminal with `smurg attach`.
- File locks for people and for agents: an agent cannot change a file someone is typing in, and a file an agent is
  changing is read-only in the editor for the moment. Where the two overlap, what the person typed is kept and the
  other side's version goes to the conflicts panel. The activity feed says who, or which agent, made each change.
- Editors send suggestions to agents; the person who opened the session, the host or a teammate with agent access
  accepts them, edits and accepts them, or rejects them.
- An agent can work in its own git worktree; when it is done, the host reads the full diff before merging. A new
  session runs in the main workspace or in a new worktree.
- The host console: members, roles, invite links, sessions and the audit log; one click removes a member or ends a
  session.
- When the host's computer sleeps or goes offline, everyone sees "Host offline" within seconds.
- The interface is in English and Traditional Chinese; everyone sees their own language
  ([`docs/HOSTING.md`](docs/HOSTING.md) §1).

## Not verified yet, and known limits

- **Agent access has no isolation at all**: the sessions a teammate with this role opens run as the host on the
  host's computer; they can run any command, read the host's home folder and use the host's Claude account (the cost
  is the host's). smurg does not limit any of this: give the role only to people you fully trust
  ([`docs/HOSTING.md`](docs/HOSTING.md) §5.1; [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §11 D-15, §12).
- **Linux hosts**: every test (including Ctrl-C and resizing in a terminal) passes on Ubuntu 24.04 (an arm64 virtual
  machine and x64 on GitHub Actions), but nobody has really hosted on Linux yet: real Claude Code has not run there,
  and the installer has not run on a fresh Linux computer. Teammates can use any operating system (a browser).
- **The macOS executables have no Apple Developer ID signature** (only an ad-hoc signature). Install with the line
  below: it checks the sha256 first, then removes macOS's quarantine flag. Only the Apple silicon executable is
  tested on the development machine; the Intel Mac and Linux executables are built by GitHub Actions on their own
  platforms and smoke-tested there.
- **The shared relay runs on Cloudflare's free plan**: everyone shares one daily quota, and when it is used up nobody
  can connect until 00:00 UTC ([`docs/HOSTING.md`](docs/HOSTING.md) §2). To avoid this limit, run your own relay
  ([`apps/relay/README.md`](apps/relay/README.md)).
- Hosts need macOS or Linux (Windows is not supported). The features of the "launch" phase are not built yet, for
  example the host running a teammate's command for them, and filters for the audit log.
- Other known limits: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §12; the current state of every acceptance
  criterion: [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

## Install (hosts)

macOS (Apple silicon, Intel) or Linux (x64, arm64, glibc):

```sh
curl -fsSL https://smurg.ai/install.sh | sh
```

`https://smurg.ai/install.sh` only redirects to `https://downloads.smurg.ai/latest/install.sh` (the newest version's
installer); the installer downloads from `https://downloads.smurg.ai/v<version>/`. The installer downloads a single
executable for this computer (no Node.js needed) and installs it to `~/.local/bin/smurg` **only if its sha256
matches that version's `SHA256SUMS`**. When `~/.local/bin` is not in your `PATH`, it prints the line to add to your
shell's startup file (on macOS it is not there by default). It is the same on every platform: no `sudo`, no system
packages. Details: [`docs/HOSTING.md`](docs/HOSTING.md) §1.

- To run Claude Code in sessions, this computer also needs the `claude` command (2.1.220 or later), already logged
  in: every agent session uses that login. Worktrees need the folder to be a git repository.
- Update: `smurg update` (run `smurg stop` first while sharing). Uninstall: `smurg uninstall` lists and removes the
  executable `~/.local/bin/smurg`, `~/.smurg` (logins, keys, workspace state) and the cache directory (macOS:
  `~/Library/Caches/smurg`; Linux: `~/.cache/smurg`); it never touches the `.smurg/` folder inside a project
  ([`docs/HOSTING.md`](docs/HOSTING.md) §9).

## Quick start: hosts

```sh
smurg login                      # log in to the shared relay with a code (confirm with your Google account in a browser on any device)
smurg host ~/projects/my-app     # share the folder; runs in the foreground, Ctrl-C stops it
```

1. `smurg login` prints an address (`https://app.smurg.ai/device`) and a code. Open the address in a browser on any
   device (a computer or a phone), log in with your Google account, enter the code, and allow the request once the
   page shows the right account (on a computer with a desktop smurg also opens the address by itself; it works the
   same over SSH, with no port forwarding). Without `--relay`, smurg uses the built-in shared relay
   https://app.smurg.ai (also the address of the web app). (You can skip this step: `smurg host` asks you to log in
   first when you are not logged in.)
2. `smurg host` prints just two links: **your own link** (opens the workspace in a browser as the host; do not give
   it to anyone) and **the invite link for teammates** (Editor role by default, valid for 7 days; `--role agent`
   makes it an Agent access link: read [`docs/HOSTING.md`](docs/HOSTING.md) §5.1 first).
3. Send the invite link to your teammates in a **private message**: the part after `#` is the secret, so never post
   it in public.

Read [`docs/HOSTING.md`](docs/HOSTING.md) before you share (above all §4, "Before you share").

## Quick start: teammates

1. Open the invite link the host sent you in Chrome on a computer (there is nothing to install; Safari and Firefox
   have not been tested yet).
2. Choose "Log in with Google". smurg uses the login only to know who you are and gets no access to your code; you do not
   need a Claude account.
3. Check the workspace and who you are logged in as, then join.

The full guide, written for people who have never used smurg or Claude Code (roles, editing together, file locks,
suggestions, agent sessions, worktrees, leaving): [`docs/JOINING.md`](docs/JOINING.md). To watch sessions in your
own terminal: install smurg as under "Install", run `smurg attach --invite -` and paste the invite link (JOINING
§10).

## Documentation

| Document | What is in it |
|---|---|
| [`docs/HOSTING.md`](docs/HOSTING.md) ([繁體中文](docs/zh-TW/HOSTING.md)) | Host guide: installing, logging in, the shared relay and your own, sharing, what to know before you share, the Agent access role and its risk, stopping, troubleshooting, updating and uninstalling |
| [`docs/JOINING.md`](docs/JOINING.md) ([繁體中文](docs/zh-TW/JOINING.md)) | Guide for teammates, also for people new to smurg and Claude Code |
| [`CHANGELOG.md`](CHANGELOG.md) ([繁體中文](docs/zh-TW/CHANGELOG.md)) | What changed in each version |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The contracts between the packages (read the rules in §0 before you write code), where smurg deliberately differs from SPEC (§11), known limits (§12) |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | The terms smurg uses, in English and Traditional Chinese, and the style of its texts |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | Every acceptance criterion, its automated tests and its state |
| [`docs/RELEASING.md`](docs/RELEASING.md) | For maintainers: deploying the shared relay, releasing a version, deploying smurg.ai, rolling back |
| [`SPEC.md`](SPEC.md), [`docs/research/`](docs/research/) | The original requirements (Traditional Chinese); the technical checks done before the code was written |
| [`apps/relay/README.md`](apps/relay/README.md) | The relay: routes, configuration, deploying it, running your own |
| [`apps/site/README.md`](apps/site/README.md) | smurg.ai: content, redirects and deploying |
| [`CONTRIBUTING.md`](CONTRIBUTING.md), [`SECURITY.md`](SECURITY.md) | How to contribute; how to report a vulnerability |

## License

smurg is open source under the MIT License: see [`LICENSE`](LICENSE) (as a web page: https://smurg.ai/license/). The
third-party software in the executables and the web app keeps its own licenses: the lists and the full license texts
are [`packages/cli/THIRD-PARTY-NOTICES.txt`](packages/cli/THIRD-PARTY-NOTICES.txt) (the executable; the version
`smurg licenses` prints also has the Node.js license) and
[`apps/web/public/third-party-notices.txt`](apps/web/public/third-party-notices.txt) (the web app,
https://app.smurg.ai/third-party-notices.txt). `node scripts/third-party-notices.ts` generates both files from
`pnpm-lock.yaml` and the installed packages; do not edit them by hand: regenerate and commit them when the
dependencies change (`pnpm check`, `scripts/build-sea.sh` and the web build all refuse stale files).

---

The rest is for developers.

## Developing from source

You need macOS or Linux, [Node.js](https://nodejs.org/) 22 LTS (22.18 or later) or 24 LTS, and git. nvm is the
easiest way to install Node (`nvm install 22`); Node 25 is outside vitest's supported range and is not supported. To
run Claude Code in sessions you also need the `claude` command (2.1.220 or later).

```sh
git clone https://github.com/gclinian/smurg.git && cd smurg
scripts/bootstrap-tools.sh                      # once: installs the pinned pnpm into .tools/ (nothing global)
source scripts/env.sh                           # in every new shell (bash and zsh both work)
scripts/with-install-lock.sh pnpm install       # installs the dependencies (about 1 GB on disk, all inside the repo)
scripts/dev-stack.sh --role agent               # starts the whole system on this computer to try it (no account needed); Ctrl-C stops everything
```

`scripts/env.sh` puts Node 22 and the repository's pnpm first in `PATH`, keeps the tools' state inside the repository
(`XDG_CONFIG_HOME=.xdg`, the pnpm store in `.tools/`, `WRANGLER_SEND_METRICS=false`, `CI=true`) and sets
`SMURG_NO_BROWSER=1`: a `smurg` run from this shell never opens your browser (see "Keeping smurg from opening a
browser"). It fails with a message when it finds no supported Node. Add a new dependency to the `package.json` of
your own package (with an exact version), then run `scripts/with-install-lock.sh pnpm install`. To run the CLI from
source: `node packages/cli/src/main.ts <command>` (or, in this terminal,
`alias smurg="node $SMURG_ROOT/packages/cli/src/main.ts"`; `scripts/env.sh` sets `SMURG_ROOT`).

Before you change code, read [`CONTRIBUTING.md`](CONTRIBUTING.md) and the rules in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §0. Every text smurg shows is written in English first and has a
Traditional Chinese counterpart; the terms are in [`docs/GLOSSARY.md`](docs/GLOSSARY.md).

## Layout

```
apps/
  web/         React + Vite front end (Monaco, Yjs, xterm.js)
  relay/       Cloudflare Worker + Durable Objects (WorkspaceDO, TransferDO); it also serves the front end (app.smurg.ai)
  site/        the product page smurg.ai (static pages, plus a small Worker for redirects such as /install.sh)
packages/
  protocol/    message schemas (zod), constants, roles, the Noise encrypted channel, the relay's control frames and routes, the shared message catalog
  daemon/      the host's daemon (files, documents, file locks, PTY sessions, worktrees, hooks)
  cli/         the `smurg` command
tests/
  e2e/         acceptance tests across packages (a real relay + daemon + headless clients)
scripts/       development environment, the single executable, release files and the install script
docs/          guides, architecture and research reports
```

Every package is "source first": `exports` points straight at the `.ts` sources, so developing and testing need no
build step (Node ≥ 22.18 runs TypeScript directly).

## Checks and common commands

```sh
pnpm check                                  # type check + tests of every package (run it before you commit)
pnpm typecheck                              # only the type check (TypeScript 7)
pnpm test                                   # only the tests (vitest, one project per package)
pnpm --filter @smurg/protocol test          # one package only
pnpm build                                  # builds the front end (Vite) and the relay (wrangler dry-run)
pnpm dev:relay                              # the relay's dev server http://127.0.0.1:8787 (local workerd, no Cloudflare account)
pnpm dev:web                                # the front end's dev server http://localhost:5173 (/auth /api /ws /xfer go to the relay)
node packages/cli/src/main.ts --version     # runs the CLI straight from source
```

The tests never reach a network beyond 127.0.0.1 and never use a real account or credential.

**The gate**: `source scripts/env.sh && pnpm check`; do not change `TMPDIR`, and run only one at a time. The number
of test files and tests a green run shows, how long it takes and the environments it was verified in are in
[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md), "How to run the gate" (the numbers change as features are added and are
recorded only there). Skipped by default: `packages/cli/test/sea.test.ts` and `packages/cli/test/sea-update.test.ts`
(they need the single executable to be built first, `SMURG_SEA_BINARY`) and `packages/cli/test/dev-stack.test.ts`
(`SMURG_TEST_DEV_STACK=1`); without a system Chrome or a verified version of `claude`, the tests that need them are
skipped too, and the numbers differ. Temporary directories and processes that a test did not clean up (a crashed
worker, for example) are removed after the whole run, with a line on stderr,
`[smurg test run] removed N leftover(s)`: a green run does not print it, so when it appears, find the test that left
them.

## Local development

One command starts the whole system on this computer (the relay, the web dev server, and `smurg host` sharing a
sample folder), with no account:

```sh
scripts/dev-stack.sh                        # sources scripts/env.sh by itself; Ctrl-C stops everything
scripts/dev-stack.sh --help                 # options: --dir, --relay-port, --web-port, --host-user, --role
```

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
4. On Ctrl-C: first lets `smurg host` stop properly (drops every connection, ends the sessions), then stops the web
   server and the relay. Every child runs in its own process group, and the script only signals the process groups
   it started and recorded itself.

`<dir>` defaults to `$TMPDIR/smurg-dev-stack`. `smurg` uses a fake `HOME` (`<dir>/home`) and its own `SMURG_HOME`
there, so it never touches your `~/.smurg`, `~/.claude` or shell startup files; when the path of `SMURG_HOME` is too
long for a Unix socket (104 bytes on macOS), it uses `/tmp/smurg-dev-<uid>-<hash>` instead. Before it ends, the
script prints the command that attaches the host to a session on this computer
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

`smurg <command> --help` prints every option of a command.

| Command | What it does |
|---|---|
| `smurg host <folder>` | Shares a folder (in the foreground) and prints two links: yours and the teammates' |
| `smurg attach [session]` | Attaches a session to this terminal (lists the sessions when you name none); Ctrl-] detaches |
| `smurg status` / `smurg stop` | Shows or stops the workspaces this computer is sharing |
| `smurg login` / `smurg logout` | Signs in to a relay with a code, or forgets the login |
| `smurg update` | Updates the installed executable to the newest version (`--check` only checks) |
| `smurg uninstall` | Removes smurg from this computer after listing what it will remove |
| `smurg licenses` | Prints smurg's license and the notices of the third-party software in the executable |

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
steps are in [`docs/RELEASING.md`](docs/RELEASING.md); each version's changes are in [`CHANGELOG.md`](CHANGELOG.md).
