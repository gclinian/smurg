<h1 align="center">
  <a href="https://smurg.ai/"><img src=".github/assets/smurg-mark.svg" width="64" height="64" alt="smurg.ai"></a>
  <br>
  smurg
</h1>

<p align="center"><b>A real-time workspace for your team and Claude&nbsp;Code.</b></p>

<p align="center">
  <a href="https://smurg.ai/">Website</a> ·
  <a href="https://smurg.ai/docs/quick-start/">Quick start</a> ·
  <a href="https://smurg.ai/docs/">Docs</a> ·
  <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <a href="https://github.com/gclinian/smurg/actions/workflows/ci.yml"><img src="https://github.com/gclinian/smurg/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/gclinian/smurg/releases/latest"><img src="https://img.shields.io/github/v/release/gclinian/smurg?label=release" alt="Latest release"></a>
  <a href="docs/HOSTING.md#108-what-was-verified-and-what-was-not"><img src="https://img.shields.io/badge/status-prototype-orange.svg" alt="Status: prototype"></a>
</p>

<p align="center">
  <a href="https://smurg.ai/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/assets/readme-picture-dark.svg">
      <img src=".github/assets/readme-picture-light.svg" width="830" alt="Illustration of a smurg workspace in a browser, in four scenes. Decide: Claude asks where the cart should be kept; Ian, Amy and Ben vote, and Ian submits the leading answer. Plan: Claude writes a spec and a plan with three work items, and Ian starts them. Build: three agents work side by side, one per work item, each in its own worktree; one asks for permission to run a command, and Ben allows it once. Review: Amy reads the result report of the first item and marks it as reviewed, and Ian, the host, merges the change into the main workspace.">
    </picture>
  </a>
</p>

<p align="center"><sub>An illustration of the app, not a screenshot. The topic and the people are made up.</sub></p>

## Quick start

1. On the computer that has your project (macOS or Linux, with Claude Code installed and logged in), install smurg:

   ```sh
   curl -fsSL https://smurg.ai/install.sh | sh
   ```

2. Share a project folder that is a git repository with at least one commit:

   ```sh
   smurg host ~/projects/my-app
   ```

   The first time, it asks you to log in with Google. Then it prints two links: one for you, the host, and one for
   your teammates.

3. Send your teammates their link in a private message. They open it in Chrome and log in with Google: nothing to
   install, no Claude account.

4. Open your own link, press "New topic", and the team's discussion with the agent starts.

Every step, up to a first topic that is reviewed and merged: [Quick start](https://smurg.ai/docs/quick-start/).

> [!WARNING]
> **Status: prototype.** Developed and tested on macOS (Apple silicon). The topics flow was verified against a
> scripted stand-in for the model, not with a real Claude account
> ([what was verified](docs/HOSTING.md#108-what-was-verified-and-what-was-not)). Agents run on the host's computer as
> the host, with no sandbox, on the host's Claude account: read [Before you share](docs/HOSTING.md#4-before-you-share)
> and [the Agent access role](docs/HOSTING.md#51-the-agent-access-role-read-this-first) first.

## What it does

- **Decide together.** Claude asks a multiple-choice question; the team votes, and one person submits the answer.
- **A spec and plan, as files.** Claude writes `SPEC.md` and `PLAN.md` into your project; people edit them together.
- **One agent per work item.** Every work item gets its own Claude Code session and git worktree; its agent asks
  before commands.
- **Review, then merge.** Each finished item comes with a result report; a person reads it, and the host merges.

Also: an inbox for each person, up to four columns side by side, three roles (Viewer, Editor, Agent access), and a
code mode with a shared editor and terminals. The interface is in English or Traditional Chinese. The
[guide for teammates](docs/JOINING.md) explains each.

## How it is built

- **Your computer** runs `smurg host`. The files, the agents and their git worktrees stay there.
- **The relay** forwards the data between you and your teammates and cannot read it: it is end-to-end encrypted
  ([what the relay can see](docs/HOSTING.md#21-the-shared-relay-default)). Use the shared one, <https://app.smurg.ai>,
  or [run your own](apps/relay/README.md#self-hosting-on-workersdev).
- **The browser** is the only program a teammate needs.

The trust model on one page: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#2-trust-model-in-one-page).

## Documentation

- [Quick start](docs/QUICKSTART.md): step by step, from installing to a first topic that is reviewed and merged
- [Host guide](docs/HOSTING.md): installing, sharing, what to know before you share, what agents may do,
  troubleshooting, updating
- [Guide for teammates](docs/JOINING.md): roles, the inbox, talking to agents, a topic from discussion to reviewed
  result
- [Changelog](CHANGELOG.md): what changed in each version
- [Architecture](docs/ARCHITECTURE.md): how smurg is built, and its known limits (§12)
- [Security](SECURITY.md): how to report a vulnerability, and what is by design

The same guides, easier to read: <https://smurg.ai/docs/>. Every document of the repository is listed in
[`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md#documents).

<details>
<summary>The <code>smurg</code> command</summary>

| Command | What it does |
|---|---|
| `smurg host <folder>` | Shares a folder (in the foreground) and prints two links: yours and the teammates' |
| `smurg attach [session]` | Attaches a terminal session to this terminal (lists every session when you name none); Ctrl-] detaches |
| `smurg status` / `smurg stop` | Shows or stops the workspaces this computer is sharing |
| `smurg login` / `smurg logout` | Logs in to a relay with a code, or forgets the login |
| `smurg update` | Updates the installed executable to the newest version (`--check` only checks) |
| `smurg uninstall` | Removes smurg from this computer after listing what it will remove |
| `smurg licenses` | Prints smurg's license and the notices of the third-party software in the executable |

`smurg <command> --help` prints every option of a command.

</details>

## Contributing

Bugs and ideas: [open an issue](https://github.com/gclinian/smurg/issues). The rules for a change are in
[`CONTRIBUTING.md`](CONTRIBUTING.md). [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) covers building from source, the
checks, and a local stack that needs no account when it is started with `--stand-in-claude` (its agents are then a
scripted stand-in). Security problems: [`SECURITY.md`](SECURITY.md), never a public issue.

## License

smurg is open source under the MIT License: see [`LICENSE`](LICENSE). The third-party software in the executable and
the web app keeps its own licenses: [`packages/cli/THIRD-PARTY-NOTICES.txt`](packages/cli/THIRD-PARTY-NOTICES.txt) and
[`apps/web/public/third-party-notices.txt`](apps/web/public/third-party-notices.txt).
