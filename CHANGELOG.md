# Changelog

Every released version's changes are recorded here (the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and version numbers follow
[Semantic Versioning](https://semver.org/)). A version's section is also its release notes; a version without a
section is not released. This changelog in [繁體中文](docs/zh-TW/CHANGELOG.md).

## [Unreleased]

- **Updating from 0.4.0 keeps your workspace.** smurg 0.5.0 refused to start on a workspace that 0.4.0 had shared,
  and told the host to move the workspace's folder away, which gives up its members, its invite links and its daemon
  key. This version reads what 0.4.0 and 0.5.0 wrote: at the first `smurg host` after the update the members with
  their roles, the devices, the invite links, the daemon key and the settings are carried over, nobody joins again,
  and nobody is asked about a changed key. One line above the links says that it happened. From now on every
  version reads what every published version before it wrote ([host guide](docs/HOSTING.md) §9.2).
- **If you followed 0.5.0's advice and moved the folder away**, it is still there
  (`~/.smurg/workspaces/<workspace code>.old`) and can be put back. `smurg host` names it once, and the
  [host guide](docs/HOSTING.md) §9.4 has the steps and what going back means for the workspace you used in between.
- **Look at roles and unused invite links once.** Members and unused links from 0.4.0 keep their role, and the
  roles do more since 0.5.0: an Editor votes, comments and reviews result reports; Agent access creates topics,
  starts work items, sends messages to agents and answers their permission requests. Nobody decided that again for
  your workspace, so change a role or revoke a link you would not give today. The three settings that 0.5.0 added
  start at their defaults, and "Agents may use my own and this project's MCP servers" is off.
- **A workspace's state that cannot be used is refused untouched, and the terminal says why.** `smurg host` now reads
  all of a workspace's state before it writes anything. Written by a newer smurg, open to other users, another
  user's file, a link, a file the system will not open, a damaged or a missing file: each has its own message, which
  names the file, says that nothing was changed and says what to do. Moving the folder away is named only as the
  last resort for a file that cannot be read, after what it costs. A state file that is missing beside its key, or a
  key missing beside its state file, is refused too; before, smurg quietly made a new, empty one in its place
  ([host guide](docs/HOSTING.md) §9.3).
- **smurg keeps a copy of every file it brings to a new form** (for example
  `state.json.before-upgrade-from-0.4.0`), so that you can look up what the workspace held. Putting a copy back
  undoes every removal, every revoked device or link and every role change since, and `smurg host` says so when it
  finds one put back. Going back to an older smurg is not supported.
- **Different versions: each side is told who has to act.** A page that the host's smurg turns away now tells a tab
  from before an update ("This tab is from before an update": reload it) from a host who has not updated yet ("The
  host's smurg is older than this page": the host updates). `smurg attach` says the same in a terminal, and
  `smurg host` tells the host in one line when it turned away a teammate whose page or smurg is newer or older.
  Before, both sides read "update smurg", whoever had to.
- **A tab left open across an update says so.** A part of the page that the update replaced shows "smurg was
  updated" with a button to reload, where there was an empty page, a column that could not be shown or a dialog that
  never opened. The panel widths and folds you set under 0.4.0 are kept. The browser never replaces a device key or
  a recorded host key that a newer page stored.
- **A `smurg` command and a running `smurg host` of different versions.** `smurg status` says that a host of another
  version is sharing (exit code 5) where it said that nothing was shared; `smurg stop` stops it; `smurg host`,
  `smurg update`, `smurg uninstall` and `smurg attach` say why they stop. The installer no longer replaces a `smurg`
  that is sharing a workspace: it asks you to stop sharing first (`--force` installs all the same). The files
  `~/.smurg/workspaces.json` and `credentials.json` of a newer smurg are refused; before, they were read as empty
  and written over.
- **If you run your own relay**: deploy it again when you update, as before. The deploy can now keep the previous
  version's page files beside the new ones (`scripts/deploy-relay.sh --keep-assets`), so that tabs opened before the
  deploy still load their parts. The protocol did not change: 0.5.0 and this version connect to each other and open
  each other's workspaces.

## [0.5.0] - 2026-10-07

- **Topics: a team takes a feature from a discussion to reviewed work.** The main screen is now built around
  topics (a feature or a task); the [guide for teammates](docs/JOINING.md) §6 walks through one.
  - Discussion: everyone talks with one shared agent. The agent asks the team multiple-choice questions; the host,
    members with agent access and Editors vote and comment and see each other's choices live, and the session's
    responsible person (when nobody is assigned: whoever opened it) submits the answer. Viewers watch.
  - Spec and plan: the agent writes `specs/<topic>/SPEC.md` and `PLAN.md` in the project. People edit both together
    in the browser or ask the agent to revise them. The plan is a list of work items; the agent suggests who is
    responsible for which, and people change it or choose "No one assigned: everyone watches".
  - Execution: Start opens one agent session per work item, each in its own git worktree, and commits the spec and
    the plan to the host's repository first (the dialog says so before). An item that depends on others starts by
    itself when those are merged, and only from the spec and the plan that were confirmed at Start.
  - Result reports: a finished item has a report with fixed sections (what was done, why, how it was verified, what
    to watch out for) and its diff. The responsible person asks follow-ups and presses "I've reviewed this"; the
    reviewed changes then wait in the host's inbox, and the host merges. A topic is complete when every item is
    reviewed.
- **Agent sessions are conversations, not terminals.** smurg now runs Claude Code as a structured conversation:
  messages, what the agent's tools did, questions and permission requests are shown as a conversation with cards,
  and everyone reads all of it, including members who join later. Plain terminal sessions stay for people who need
  a shell. No longer there: typing into an agent's terminal, Claude Code's slash commands and `/login` inside a
  session, and attaching an agent to your own terminal (`smurg attach` attaches terminal sessions and lists the
  agent sessions with their topic and status). A message reaches an agent as it was written: `@path` in it is not
  replaced by the file, so name the path and the agent reads the file itself.
- **An inbox for every member**: the questions you decide, votes that are open, permission requests, work that
  stopped and needs someone, suggestions, result reports to review, changes ready to merge, and mentions (`@name`).
  An item leaves when the thing is settled. When the person who must answer a question or a permission request does
  not (5 minutes by default; a host setting), it also reaches the host and the members with agent access, who can
  answer in their place; a result report nobody reviewed does the same after six times as long.
- **The sessions view and code mode.** The inbox and the session list, grouped by topic, are on the left; on the
  right up to four columns stand side by side (a conversation, a spec, a plan, a result report). The file tree, the
  editor, the activity feed and the terminals are now "Code mode", behind a switch in the top bar; both sides keep
  their state.
- **Agents ask before they run commands.** A work item's agent edits files in its own worktree without asking and
  asks before commands, except read-only commands and simple file commands inside the worktree; only the host and
  members with agent access can allow a request, once or always for that kind of command, in one session or in
  every session of a topic. A request is shown whole, with characters nobody can see written out, and a long one
  has to be scrolled to its end before it can be allowed; "always allow" is not offered for a command made of
  several. smurg's own check runs before every tool call of
  an agent, whatever Claude Code's settings allow: a discussion agent can only read the project and write its
  topic's spec and plan. See the [host guide](docs/HOSTING.md) §5.2.
- **Suggestions go to agent sessions**, no longer to terminals. An Editor's message is a card in the conversation
  and reaches the agent only when the host or a member with agent access accepts it, as exactly the text that was
  shown. Editors can now also vote, comment, be responsible for a session or a work item and review its report.
- **Your own Claude Code on the host's side** ([host guide](docs/HOSTING.md) §5.3): the allow rules of the host's own
  Claude Code settings apply to agent sessions, and the host is told once which; the host's MCP servers are off for
  agents unless the host switches them on; a shared folder's Claude Code project settings (the settings files and
  everything else in `.claude/`) are used only after the host has confirmed what they do, and while they are in
  use only the host can change the scripts they run: an agent's shell command that could change one asks a person
  first, whatever is always allowed; `CLAUDE.md` can be changed through smurg only by the host, and a teammate
  cannot rename or delete a folder that holds a file only the host may change.
- **Whose Claude account**: agents still use the host's Claude Code login for everyone. A personal Pro or Max
  subscription is for the host's own use: the host guide (§4), the dialog that starts a topic and the host console
  now say which kind of account fits a group, and the host is told once per workspace when agents use a personal
  subscription and the workspace has other members.
- **Agent sessions survive a restart.** `smurg stop` ends terminal sessions and pauses agent sessions; their
  conversations are kept on the host's computer (in `~/.smurg`, removed by `smurg uninstall`). After `smurg host`
  starts again nothing runs by itself: a plan that was being carried out is paused until the host or a member with
  agent access chooses "Continue all", and a message that was still waiting for its agent is delivered when that
  session continues. `smurg status` now also shows Claude Code's version and login, the agent sessions, the topics,
  and whether the folder's Claude Code project settings are confirmed.
- **Requirements**: agent sessions need Claude Code 2.1.288 or later on the host's computer (an older one is
  refused); carrying out work items needs the shared folder to be a git repository with at least one commit, and git
  2.42 or later.
- **This version does not read what an earlier one wrote.** The host, the web app (the relay's version) and every
  `smurg attach` must run this version: the protocol between them changed (version 4), and a different version is
  refused when it connects. A workspace's state from an earlier version (members, invite links, sessions) is not
  converted: `smurg host` says so and names the folder to move aside ([host guide](docs/HOSTING.md) §8). If you run
  your own relay, deploy it again from this version before you update.
- **What was verified**: the topics flow was tested with a scripted stand-in for the model, and real Claude Code
  2.1.288 only against a fake API, never against the real model, on macOS only (not on Linux); no real Claude
  account was used. How a real model behaves in the flow may need tuning in later versions
  ([host guide](docs/HOSTING.md) §10.8).
- **Limits to know** ([host guide](docs/HOSTING.md) §10.8): agents start no subagents in this version, and agent
  definitions in `.claude/agents` are not used. In a folder whose project settings run scripts, smurg's check of
  an agent's shell commands sees what a command names; a program that names none of the scripts (a build, a
  script that rewrites another) is not seen before it runs, so keep hook scripts in `.claude/hooks/`. Removing an
  entry of a conversation does not remove the cards, the inbox excerpts and the audit entries that hold the same
  text. A link in what an agent or a member wrote shows where it leads when you rest the pointer on it or reach it
  with the keyboard; smurg writes the destination out beside the words when they name another place, but it does
  not recognize every look-alike (a name under a less common ending such as `amazon.in`), so look before you
  follow a link ([guide for teammates](docs/JOINING.md) §5). A text that takes too long to format is shown as it
  was written. One upload can have at most 10,000 folders.

## [0.4.0] - 2026-10-02

- **English first, Traditional Chinese second.** Everything smurg shows now exists in both languages, and English is
  the default: the web app, the `smurg` command, the relay's login pages, the installer, the guides and smurg.ai.
  Everyone sees their own language, also inside one workspace: a host can use English while a teammate uses
  Traditional Chinese.
  - Web app: it starts in your browser's language (Traditional Chinese if that comes first among the languages smurg
    supports, otherwise English), and the new language menu switches it without reloading; the choice is remembered
    and the relay's login pages follow it.
  - `smurg` and the installer: they follow the computer's locale (`LC_ALL`, `LC_MESSAGES`, `LANG`; on macOS, when
    none of the three is set, the system language) and print English for anything that is not Traditional Chinese.
    `SMURG_LANG=en` or `SMURG_LANG=zh-TW` chooses it yourself.
  - The role names in English are Host, Agent access, Editor and Viewer. An agent's name is now written the same way
    in both languages, `Claude (Amy)`.
  - What agents read (hook messages, MCP tool texts), git commit messages and logs are English in every language.
  - The guides are in English at https://smurg.ai/docs/ and in Traditional Chinese at https://smurg.ai/zh-TW/docs/;
    the [host guide](docs/HOSTING.md) §1 says how the language is chosen.
- **smurg is now open source under the MIT License.** The source code is at https://github.com/gclinian/smurg, and
  the license is at https://smurg.ai/license/. Versions 0.1.0 to 0.3.0 were proprietary builds and can no longer
  be downloaded. Because the relay's source is public too, you can now run your own relay on your own Cloudflare
  account instead of the shared one ([host guide](docs/HOSTING.md) §2.2).
- The host and every `smurg attach` must run this version: the protocol between them changed (version 3), and a
  different version is refused when it connects. The web app is always the relay's version. Activity lines that an
  older version recorded are no longer shown in the activity feed.
- Releases: the executables are published only at https://downloads.smurg.ai; the GitHub release of a version carries
  its release notes, `SHA256SUMS` and the third-party notices.
- Fixed in the web app: the tab of a session that has ended can now be closed (a close button on the tab, the Delete
  key or a middle click; each viewer closes their own tabs, and running sessions cannot be closed this way). A tab
  left open long after its session ended says that its content is gone, instead of offering a retry that could not
  work.
- Fixed in the web app: the divider between the editor and the session area (and the other three dividers) no longer
  moves by itself when the pointer only passes over it. It moves only while the primary mouse button is held, stays
  under the pointer where you grabbed it, and can be grabbed from either side; Escape cancels a drag, and a double
  click resets the size.
- Fixed in the web app: "New file", "New folder" and the upload button in the header of the file tree now use the
  top folder until you select something in the tree. For the host they used to target the first folder listed,
  `.smurg`, smurg's own folder.

## [0.3.0] - 2026-10-02

- **`smurg update`**: updates smurg to the newest version. It downloads this computer's executable from
  `https://downloads.smurg.ai`, replaces the current executable in place only when its sha256 matches that version's
  `SHA256SUMS`, and prints the old and the new version; `smurg update --check` only checks whether a new version
  exists. Run `smurg stop` first while sharing (you cannot update while sharing). When a new version exists,
  `smurg host` prints one more line under the two links; set `SMURG_NO_UPDATE_CHECK=1` to turn that check off. See
  the [host guide](docs/HOSTING.md) §9.
- **`smurg uninstall`**: removes smurg from this computer: the executable, the cache and `~/.smurg` (logins, keys,
  workspace state; `--keep-data` keeps it). It first lists every path it will remove and acts only after you confirm
  (`--yes` does not ask); a workspace that is being shared is stopped first. The `.smurg/` folder inside a project
  folder (worktrees and changes not merged yet) is never touched, only listed for you to decide.

## [0.2.0] - 2026-10-02

- **The "can run agents" role became "can use agents" (Agent access), and teammates no longer have agents and a
  sandbox of their own**: the host can give Agent access to teammates they fully trust; such a teammate can open
  agents and terminals on the host's computer (in the main workspace or a worktree) and type into any session. These
  sessions **run as the host**: with the host's Claude Code login (the cost is the host's), on the host's computer,
  with no sandbox, so this teammate can make an agent run any command and read the host's home folder. Editors send
  suggestions as before and Viewers only watch as before; worktrees work as before, a teammate with agent access can
  request a merge for any worktree, and the host still decides every merge.
  See the [host guide](docs/HOSTING.md) §5.1, including what to check after taking the role back.
- Removed with that: the guest sandbox (Seatbelt on macOS, bubblewrap on Linux), teammates' Claude login and API
  keys, "import personal settings", `--no-guest-subscription-login` and `--allow-main-workspace-guests` /
  `--no-main-workspace-guests`. On Linux the installer no longer installs bubblewrap, socat, ripgrep or an AppArmor
  profile: on every platform it installs only the executable and needs no sudo.
- The control socket on this computer (the one `smurg attach` uses on the host's own computer) can now only list
  sessions, attach to them and type into them. Every session runs under the host's operating-system account, so a
  teammate with agent access can reach the socket too; changing roles, removing members, ending sessions, approving
  merges, invite links, settings and the audit log are only possible in the web app, and the live audit log and
  host-only notifications are not sent to the control socket either. The audit log marks what was done through the
  control socket with `via: control-socket`, and counts its refusals separately, so they cannot push out the record
  of what was refused to you in the web app.
- After the host replaced the workspace's keys (for example, moved the workspace state away and shared again after
  taking Agent access back; see the [host guide](docs/HOSTING.md) §5.1), a teammate who had joined with
  `smurg attach` and joins with the new invite link is told, as in the web app, that the host's computer key has
  changed: `smurg attach` prints the fingerprint it recorded and the invite link's, and switches to the new key only
  after the teammate confirms with `y` (outside a terminal, with `--accept-new-key`); before, it only dropped the
  connection and there was no way to continue. `smurg attach --help` is corrected too: the host and teammates with
  agent access can type into any session.
- When a workspace's state files were written by another smurg version (or have the wrong format), `smurg host` says
  that this is the reason, records which file and what is wrong in the log file, and explains how to share again
  (move `~/.smurg/workspaces/<workspace code>/` away and share once more; teammates join again). smurg does not
  convert other versions' state.
- When it starts sharing, `smurg host` prints only the two links (yours and the teammates') and how to stop. What to
  know before sharing, what each setting means, the key fingerprint, keep-awake and the log file are explained in the
  [host guide](docs/HOSTING.md) (§3 to §7); the terminal speaks up only when you need to act: the computer cannot be
  kept awake, and connection, login and state-file problems while sharing. `smurg status` now also shows the
  relay's address, the daemon key fingerprint, whether attribution of agents' shell commands is on, and where the
  log file is.
- **Logging in to the relay with a code**: `smurg login` (and `smurg host` and `smurg attach` when they need a
  login) prints an address (shared relay: `https://app.smurg.ai/device`) and a code of 8 letters (valid for 10
  minutes). Open the address in a browser on any device (a computer or a phone), log in with your Google account
  and enter the code; the confirmation page lists the account that will be logged in, where the request came from
  (IP address and approximate location) and when, and allowing it completes the login. Allow it only if you
  yourself just ran `smurg login`; deny a code someone else gave you. A computer with a desktop opens the address by
  itself (without the code); **over SSH you no longer need `ssh -L` port forwarding**: enter the code on the computer
  or phone in front of you. Ctrl-C cancels while it waits. See the [host guide](docs/HOSTING.md) §2.
- The old way of logging in (a confirmation code on a browser page, with the result sent back to a local port on
  this computer) is removed. `smurg login --provider` is removed too: you choose how to log in in the browser.

## [0.1.0] - 2026-10-01

(Withdrawn from downloads.smurg.ai on 2026-10-02 and replaced by 0.2.0.)

The first released version: a prototype. One person (the host) runs `smurg host` on their own computer to share a
project folder; teammates connect through the relay with a browser or the `smurg` command, edit files together in
real time, and watch and steer Claude Code together. Files and agent sessions stay on the host's computer; the relay
only forwards end-to-end encrypted data and cannot see the content.

### Installing and logging in

- One line installs a single executable (no Node.js needed): `curl -fsSL https://smurg.ai/install.sh | sh`
  (smurg.ai only redirects to the newest version's `https://downloads.smurg.ai/latest/install.sh`; this version:
  `curl -fsSL https://downloads.smurg.ai/v0.1.0/install.sh | sh`).
  There are four builds, macOS (Apple silicon, Intel) and Linux (x64, arm64, glibc); the installer installs only an
  executable whose sha256 matches the published `SHA256SUMS`, to `~/.local/bin/smurg`, without sudo. On Linux it
  checks for the packages the guest sandbox needs (bubblewrap, socat, ripgrep) and for the AppArmor restriction of
  Ubuntu 24.04 and later, and installs them with sudo **only after the host agrees**.
- The shared relay https://app.smurg.ai (Cloudflare Workers; it is also the web app: a teammate's invite link is
  `https://app.smurg.ai/join/<workspace>#…`) is smurg's built-in default relay, and hosts and teammates both log in
  with a Google account: `smurg login`. `smurg login --relay <address>` uses another relay that the maintainer
  provides.
- Product page: https://smurg.ai (English) and https://smurg.ai/zh-TW/ (Traditional Chinese); documentation
  (Traditional Chinese): https://smurg.ai/docs/.
- When sharing on **Linux**, teammates' sessions can by default run only in their own worktree (the shared folder
  must be a git repository); to let teammates open sessions in the main workspace too, share with
  `smurg host --allow-main-workspace-guests` (the start message lists the limits on Linux). macOS allows it by
  default; `--no-main-workspace-guests` turns it off.

### License

- smurg is proprietary software and its source code is not public. The executables and the web app are free to use
  during the prototype, but may not be distributed, modified or reverse engineered (except where the law allows it);
  the terms are at https://smurg.ai/license/.
- The third-party software in the executables and the web app keeps its own licenses: `smurg licenses` prints
  smurg's terms and the notices of the third-party software in the executable, and every version comes with a
  `THIRD-PARTY-NOTICES.txt` (https://downloads.smurg.ai/v0.1.0/THIRD-PARTY-NOTICES.txt); the web app's are at
  https://app.smurg.ai/third-party-notices.txt.

### What it can do

- The host shares a folder with one command, which prints an invite link; teammates have one of three roles:
  "viewer", "editor" and "can run agents".
- A file tree and an editor in the browser: several people edit together in real time, with automatic saving;
  drag-and-drop uploads (resumable after a dropped connection), and downloads of a file or a whole folder (zip).
- Real Claude Code on the host's computer: the host's sessions are not sandboxed; a teammate who "can run agents"
  opens their own sessions, in a sandbox, logged in with their own Claude account. Everyone sees every session live
  and can attach one to their own terminal with `smurg attach`.
- File locks for people and for agents; where they overlap, what the person typed is kept and the other side's
  version goes to the conflicts panel. The activity feed says who, or which agent, made each change (including files
  an agent changed with a shell command).
- Suggestions to someone else's agent, which the session's owner accepts, edits and accepts, or rejects.
- An agent can work in its own git worktree; when it is done, the host reads the full diff and merges. A teammate who
  opens a session chooses the main workspace or their own worktree; a Linux host allows only worktrees by default
  (`--allow-main-workspace-guests` opens the main workspace), and the teammate's page explains why.
- The host console: members, roles, invite links, sessions and the audit log; one click removes a member or ends a
  session.
- When the host's computer sleeps or goes offline, everyone sees "host offline" within seconds.

### Known limits

- **Linux hosts**: the full test suite (including the guest sandbox and worktrees) passes on Ubuntu 24.04 (an arm64
  virtual machine and x64 on GitHub Actions), but nobody has really hosted on Linux yet: real Claude Code has not run
  in the Linux sandbox, and the Linux part of the installer has not run on a fresh computer. The guest sandbox needs
  bubblewrap 0.8 or later (the version in Ubuntu 24.04 and Debian 12 or later is fine; the 0.6 of Ubuntu 22.04 is
  too old, and guest sessions are refused). The Linux sandbox cannot do a few things the macOS one can, so **a Linux
  host does not let teammates open sessions in the main workspace by default**, and teammates can use only their own
  worktree; when the shared folder is not a git repository, teammates cannot open sessions on a Linux host's
  computer by default (the host can allow it with `--allow-main-workspace-guests`). Once the host allows it, the
  main limits are: a session a teammate opens in the main workspace can create host-only settings such as
  `.claude`, `.mcp.json` and `.git` inside subfolders (at the top level, and where they already exist, this is
  blocked, as long as the host does not delete, rename or replace them while the teammate's processes run), so the
  host has to check before opening their own tools in such a subfolder
  ([host guide](docs/HOSTING.md) §5); and while a teammate's processes run, the sandbox cannot follow when the host
  saves, creates, deletes or renames (for example with `git switch`) files such as `.envrc`, `.mcp.json`,
  `.claude/` (including the `.claude/settings.local.json` the host's own Claude Code writes on "don't ask again")
  and `CLAUDE.local.md` in the shared folder: smurg ends every teammate process in that folder once it notices
  (usually within 0.1 seconds; inside nested subfolders created in one go by `mkdir -p`, `git checkout` or
  unpacking, at the next scan, usually within seconds) and lists the file names in the terminal of `smurg host`, but
  until then a teammate's process may read the new content or overwrite it. So ask teammates to end their sessions
  before you edit those files. While a teammate's processes run, a `.claude`, `.git`, `.vscode` or `.idea` that did
  not exist at the top of the project (or of the teammate's worktree) appears for the time being as an empty folder,
  and `.mcp.json` and `.envrc` as empty read-only files; they are removed when all the processes have ended. In the
  host's git repository they are listed in `.git/info/exclude` for that time, so `git status`, `git add -A` and
  `git stash -u` leave them alone (`git add -f`, `git clean -x` and `git stash -a` do not). When `smurg host` is
  started over SSH, Ubuntu does not allow keeping the computer awake by default.
  Teammates can use any operating system (a browser).
- In the main workspace teammates can write file names such as `.gitmodules`, `.gitconfig`, `.bashrc`, `.zshrc` and
  `.profile` (the same on macOS and Linux: `smurg host` always runs from its own working directory `~/.smurg/cwd`,
  and the sandbox no longer decides by where `smurg host` was started whether to block these names). git and the
  shell do not run them from a project folder; look at `.gitmodules` before you run `git submodule update`.
- **The macOS executables have no Apple signature**: only an ad-hoc signature, no Developer ID signature and no
  notarisation. Installed with the `curl` line above, Gatekeeper does not block them (after checking the sha256, the
  installer removes the quarantine attribute a downloaded file may carry); an executable downloaded with a browser
  is blocked.
- **There is only one relay, shared, on Cloudflare's free plan**: everyone shares the daily limits on requests and
  writes. Estimated from the code (not measured on Cloudflare), about 4 to 7 workspaces with someone connected all
  day use them up, and several people watching a terminal that prints a lot use them faster; once they are used up,
  nobody can connect until 00:00 UTC, 08:00 in Taiwan ([host guide](docs/HOSTING.md) §2.1). The source code is not
  public, so for now there is no way to run your own relay to avoid this limit.
- **The guest sandbox has no limit on memory, disk space or CPU** (macOS and Linux): a teammate's processes can slow
  the host's computer down or use up its memory or disk; the number of processes is limited to 4096 per sandbox on
  Linux, while on macOS they share one limit with the host's own, so a fork bomb keeps the host's computer from
  starting new processes until that session ends.
- A teammate logging in with a Claude subscription account has not been tested from start to finish with a real
  account yet (logging in with an API key does not have this problem).
- The features of the "launch" phase are not built yet, for example the host running a teammate's command for them,
  and filters for the audit log.
- The executables need macOS 11 or later, or Linux with glibc 2.28 or later (Ubuntu 20.04 and later); musl (Alpine)
  and Windows hosts are not supported.
