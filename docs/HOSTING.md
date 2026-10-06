# Host guide: share a folder with smurg

This guide is for the **host**: the person who runs `smurg host` on their own computer to share a project folder with
teammates. Teammates should read the [guide for teammates](JOINING.md). This guide in [繁體中文](zh-TW/HOSTING.md).

What your team does in a workspace: you start a **topic** (a feature or a task), everyone discusses it with an agent
that asks multiple-choice questions and writes a spec, the agent turns the spec into a plan of work items, one agent
per work item does the work in its own git worktree, and people read each result report and mark it reviewed. The
agents are Claude Code, running on your computer with your Claude account. The guide for teammates describes the
flow step by step; this guide is about what it means for you and your computer.

## 1. Install

One line installs smurg (macOS: Apple silicon, Intel; Linux: x64, arm64, glibc):

```sh
curl -fsSL https://smurg.ai/install.sh | sh
```

`https://smurg.ai/install.sh` only redirects to `https://downloads.smurg.ai/latest/install.sh`, the installer of the
newest version. The installer downloads that version's executable from `https://downloads.smurg.ai/v<version>/` and
checks it against the same version's `SHA256SUMS`. To install a specific version, run that version's installer:
`curl -fsSL https://downloads.smurg.ai/v<version>/install.sh | sh` (replace `<version>` with a version number of the
form `X.Y.Z`).

The installer downloads a single executable for this computer (no Node.js needed), installs it to
`~/.local/bin/smurg` **only if its sha256 matches that version's `SHA256SUMS`**, and tells you how to add
`~/.local/bin` to your `PATH` (open a new terminal afterwards). On every platform it installs just this executable:
no `sudo`, no system packages.

- The macOS executable has no Apple Developer ID signature (only an ad-hoc signature). After checking the sha256, the
  installer removes macOS's quarantine flag, so Gatekeeper does not block the first run. Install with the line above;
  do not download the executable with a browser and run it by hand.
- Update: `smurg update`; remove: `smurg uninstall` (both in §9). `smurg --version` shows the current version.
- To run agents, this computer also needs the `claude` command (Claude Code **2.1.288 or later**), **already logged
  in** to your Claude account: every agent session uses this computer's login, whoever in the workspace it works for
  (§4, §5.1). An older Claude Code is refused for agent sessions; with a newer one than this smurg was verified
  with, agent sessions run and you get one notification that says so. `smurg status` shows which it is (§7).
- To let agents carry out work items, the folder you share must be a **git repository** with at least one commit,
  and this computer needs git 2.42 or later (§10.2). Without git, a topic's discussion, spec and plan still work.
- **Language**: smurg's interface comes in English and Traditional Chinese, and everyone sees their own language. The
  `smurg` command follows this computer's locale (`LC_ALL`, `LC_MESSAGES`, `LANG`; on macOS, when none of the three
  is set, the system language) and uses English for anything that is not Traditional Chinese; to choose yourself, set
  the environment variable `SMURG_LANG=en` or `SMURG_LANG=zh-TW`. The web app follows the browser's language and has
  a language menu. This guide quotes the English interface; a teammate using the Traditional Chinese interface sees
  the same sentence in Chinese.
- smurg is open source under the MIT License: the terms are at https://smurg.ai/license/ and the source code is at
  https://github.com/gclinian/smurg. The third-party software in the executable and its licenses: `smurg licenses`, or
  https://smurg.ai/third-party-notices.txt.

## 2. Log in to the relay

The relay is smurg's server: it handles login and forwards **encrypted** data between your computer and your
teammates. Invite links and the web app's workspaces also live at the relay's address.

```sh
smurg login          # without --relay, the shared relay (§2.1)
```

The terminal prints an address and a code:

```text
On any device (a computer or a phone), open:
  https://app.smurg.ai/device
Enter the code: WDJB-MJHT   (valid for 10 minutes)
```

1. Open the address in a browser on **any device** (this computer, another computer or a phone) and log in with
   your Google account.
2. Enter the code from the terminal (case and the "-" do not matter) and press "Next".
3. The page lists the account that will be logged in, where the request came from (IP address and approximate
   location) and when. **Press "Allow" only if you yourself just ran `smurg login` in a terminal; if someone else gave
   you the code, press "Deny".** A few seconds after you press "Allow", the terminal says "Logged in to …".

- On a computer with a desktop, smurg also opens the address in this computer's browser. The address never contains
  the code: you always type the code yourself.
- **Over SSH, or on a server without a desktop**: it works exactly the same. Open the address on the computer or
  phone in front of you and enter the code; no port forwarding or other setup is needed (smurg does not open a
  browser on that machine). The IP address and location on the page are then the remote machine's.
- `--no-browser` or the environment variable `SMURG_NO_BROWSER=1`: never open a browser, only print the address and
  the code.
- A code is valid for 10 minutes and works once. If it expired or you pressed "Deny", run `smurg login` again; press
  Ctrl-C to cancel while it waits.
- Do not tell anyone the code, and do not enter a code someone else gives you: entering it and pressing "Allow"
  logs the computer that ran that `smurg login` in as you (for 7 days).
- You can skip this step: `smurg host` asks you to log in first when you are not logged in (the same address and
  code). Before it starts sharing, `smurg host` also asks you to log in again if your login expires within 24
  hours.
- The login is stored in `~/.smurg/credentials.json` (mode 0600), one entry per relay address.

### 2.1 The shared relay (default)

smurg's maintainer runs a relay on Cloudflare that anyone may use: https://app.smurg.ai (it is also the web app:
teammates' invite links and workspaces are at this address). A released smurg uses it by default, so **you do not
need to deploy anything**; you only need a Google account (hosts and teammates both log in with Google).

**What the relay can see**:

- It cannot see: file contents, file names, conversations with agents, terminal output, the commands you or your
  teammates type, the secret in an invite link, or any key. These are end-to-end encrypted between your computer and
  each teammate's browser (or CLI); the relay only forwards the encrypted data.
- It can see: **which Google account** each connection belongs to (account ID, name and picture; at login Google
  also gives the relay your email, used as the display name only when the account has no name), **the IP address it
  connects from**, which workspace code it connects to, and the size and time of every message. From these it can
  tell who worked with whom and when, and how much data they sent.
- It stores: each workspace's code and which account is its host. Logins themselves are not stored (a relay login
  is a signed token valid for 7 days); only when you log `smurg` in with a code does the relay keep that request for
  at most 10 minutes (the code, and the IP address and approximate location of the computer that ran `smurg login`,
  shown on the confirmation page), and it deletes it when the login completes or expires. To stop code guessing and
  mass logins, the relay also keeps hashes of IP addresses and accounts with counters, deleted after 10 minutes.
- Whoever runs the relay (smurg's maintainer) and Cloudflare can therefore know what "it can see" lists. If that is
  not acceptable, run your own relay (§2.2): then it is you and your Cloudflare account that can see it.

**Limits of the free plan**: the shared relay runs on Cloudflare's free plan, and **everyone who uses the shared
relay shares** one fixed daily quota:

- What counts: connections, the "is the host still there" check every few seconds, and every forwarded message. The
  most expensive thing is **several people watching agents that are writing, or a terminal that prints a lot**; an
  open workspace with occasional edits uses very little.
- When the day's quota runs out, **everyone** (not only you) may be unable to connect: new connections and logins
  fail and existing connections may drop, until the quota resets at **00:00 UTC** (08:00 in Taiwan). The host's
  terminal then reports that the connection to the relay was lost, teammates see "Server unreachable", and the
  browser may show a Cloudflare error page (Error 1027).
- The maintainer watches the usage and moves to a paid plan if needed. If a whole class will use smurg for hours at
  the same time, or you cannot accept interruptions, run your own relay (§2.2): it has its own quota, which nobody
  else can use up.

### 2.2 Other relays (`--relay`)

The relay's source code is public (MIT), so **you can run your own relay**: it is a Cloudflare Worker that you deploy
with your own Cloudflare account (the free plan is enough) and your own Google OAuth client, and it serves the web app
too. The steps are in the relay's README, [`apps/relay/README.md`](../apps/relay/README.md#self-hosting-on-workersdev). Once it runs, name it
with `--relay`:

```sh
smurg login --relay https://relay.example.org      # your relay's address; that relay decides which login buttons appear
smurg host ~/projects/my-app                        # uses the relay you last logged in to
```

The relay is chosen in this order: `--relay`, the environment variable `SMURG_RELAY_URL`, the relay you last logged
in to, and only then the shared relay. To go back to the shared relay: `smurg login --relay https://app.smurg.ai`.
The invite links you print point at the relay you use, so teammates need no setup. A relay also serves the web app,
and the web app, your `smurg` and every `smurg attach` must be the same version: update your own relay when you
update smurg.

## 3. Share

```sh
smurg host ~/projects/my-app
```

`smurg host` runs in the foreground, and the terminal prints just two links:

```
smurg is sharing "my-app"

Your link (for you only):
  https://app.smurg.ai/join/ws_…#k=…&s=…

Link for your teammates (send it to them privately; valid for 7 days):
  https://app.smurg.ai/join/ws_…#k=…&s=…

Press Ctrl-C to stop sharing.
```

- **Your link**: opens the workspace in a browser as the host. It works once and is valid for 7 days; do not give it
  to anyone.
- **Link for your teammates**: the default role is Editor (`editor`); the link is valid for 7 days with no limit on uses.
  The part after `#` is the secret: send the link in a private message and never post it in public. Options:
  `--role agent|editor|viewer`, `--expires 12h`, `--max-uses 3`, `--name <display name>`; when you choose another
  role or a use limit, this line says so. **Read §5.1 before you use `--role agent` (Agent access)**: whoever gets
  that link can run any command on your computer, with your Claude account.

The terminal does not repeat this guide: **read §4 before you share for the first time**; Agent access, what agents
may do by themselves and how your own Claude Code settings count are in §5; what a topic asks of you is in §10. For
details while sharing, use `smurg status` (§7): the daemon key fingerprint, Claude Code and the agent sessions,
keep-awake, and where the log is. The terminal speaks up only when you need to act: **the computer cannot be kept
awake** (§6), the connection to the relay is lost, the relay refuses your login, or the state file cannot be written
(§7); when a new version exists, one more line appears under the links (§9.1).

**Daemon key fingerprint**: the first time a teammate joins, they can check this fingerprint with you over another
channel (in person, on the phone) to make sure nobody, the relay included, is posing as you. `smurg status` shows it
(the "Daemon key fingerprint" line).

Roles: Viewer (`viewer`) can only look; Editor (`editor`) can edit files, vote and comment on agents' questions,
review result reports and send suggestions to agents; Agent access (`agent`) can also start topics and work items,
send messages to agents, allow what agents ask to run and open terminals on your computer **as you** (§5.1). Later
you can manage members, roles, invites and sessions, and read the audit log, in the host console of the web app.

When you share a folder again later, its topics and the agent sessions of last time are still there, with their
conversations; nothing runs by itself until someone continues it (§7, §10.5).

## 4. Before you share

`smurg host` does not print these reminders in the terminal: read them before you share for the first time.

- **Every member can see the files in the folder** (viewers too), for example `.env` and configuration files. The
  only things teammates cannot see or download in the web app and the CLI are: smurg's own `.smurg/`, every `.git`
  folder, `.envrc`, and your personal Claude Code settings (`.claude/settings.local.json`, `CLAUDE.local.md`). This
  limits what people see. Agents are told not to read those files either, and Claude Code enforces that for its own
  tools and for commands that name them; but a command that you or a member with agent access allows runs as you
  and can read whatever your account can read, and so can a terminal session (§5.1). Do not share a folder that
  holds passwords, keys or personal data; you also cannot share your whole home folder or a folder that contains it.
- **Every member can read every conversation with an agent**, also a member who joins later: they can read every
  earlier conversation of the workspace, the ones of archived topics included. The host console says so where you
  create an invite link:
  "A new member can read every earlier conversation of this workspace, the ones of archived topics included."
  And whatever an agent reads, it may repeat: in its answers, in the spec, in a result report.
  smurg replaces text that looks like a well-known kind of key or token with `[masked]` before it stores or shows
  it, but that is best effort. Do not let agents work in a folder whose files, or whose commands' output, hold
  secrets (§5.4 says where conversations are kept and how to delete them).
- **Whose Claude account works for the group**: every agent uses the account `claude` is logged in to on this
  computer, also when it works for a teammate; the usage and the cost are yours. **A personal Claude subscription
  (Pro or Max) is for your own use.** Anthropic's terms do not allow making a personal account available to other
  people; for a group, log Claude Code in with an API key, a Team or Enterprise plan, or a cloud provider. smurg
  does not stop you; it tells you in three places. The dialog that starts a topic says whose account the agent
  uses. The host console's security notes say what fits a group:
  "Agents here use your Claude Code login. A personal Pro or Max subscription is for your own use: when other people work with agents here, use an API key or a Team or Enterprise plan."
  And when an agent starts while Claude Code reports a personal subscription login and the workspace has members
  besides you, you (and only you) get one notification in the web app, at most once each time you share (it stays
  in the host console, above the list of sessions, until you press "Got it"):
  "Agents here use your personal Claude subscription. Anthropic's terms do not allow making a personal account available to other people; for a group, use an API key, a Team or Enterprise plan, or a cloud provider."
- **No agent session is sandboxed.** smurg limits what an agent does by itself and asks before commands (§5.2),
  but whatever is allowed runs under your operating-system account. Agents read files that teammates wrote or
  changed, and the spec and the plan, which every Editor can edit: a file can hide instructions meant for the agent
  (prompt injection). Read a command before you allow it, think before you always allow a kind of command, and
  watch files that teammates changed recently. Teammates with agent access can also answer those requests.
- **Give Agent access only to people you fully trust** (§5.1): this role lets someone make an agent run any command
  on your computer, read your home folder and use your Claude account. Other teammates can take part as Editors:
  they edit with you, vote, comment, review and send suggestions to agents.
- Teammates can use the workspace only while `smurg host` is running and your computer is online.
- Editors and above can create or change files such as `.gitmodules`, `.gitconfig`, `.bashrc`, `.zshrc` and
  `.profile` in the shared folder (git and the shell do not run them from a project folder). Look at `.gitmodules`
  before you run `git submodule update`. Files that Claude Code reads as settings or as instructions (`.claude/`,
  `.mcp.json`, `CLAUDE.md`) can be changed through smurg only by you (§5.3).

## 5. Agent access and agents' shell commands

### 5.1 The Agent access role (read this first)

Agent access (`agent`) is the highest role you can give a teammate. A teammate with this role can:

- **start topics and work items**, and open agent sessions and terminal sessions on your computer, in the main
  workspace or in a worktree;
- **send messages to any agent**, stop it, and **allow what agents ask to run** (§5.2), once or always for a kind
  of command;
- type into **any** terminal session, including the ones you opened and the ones other teammates opened;
- accept or reject the suggestions any agent session receives, answer an agent's question in their own words, and
  ask you to merge any worktree (only you decide a merge).

These sessions **run on your computer as you**, exactly like the ones you start in your own terminal:

- **No sandbox**: your operating-system account, your home folder (including your settings, `CLAUDE.md` and memory
  in `~/.claude`) and your environment variables.
- **Your own Claude Code login**: every agent uses the account `claude` is logged in to on this computer (your
  subscription or your API key), and **the usage and the cost are yours** (§4 says which kind of account fits a
  group). Teammates do not need, and cannot use, their own Claude account or API key.
- A worktree is only a place to work, not protection: a session opened in a worktree runs as you all the same.

**The risk**: giving someone Agent access means letting them use your account on your computer. They can:

- make an agent or a terminal **run any command on your computer**: install or delete programs, change or delete
  files outside the shared folder, connect anywhere on the network;
- **read your home folder**: the keys in `~/.ssh`, other projects, the credentials of other programs and cloud
  services, and the `.git` and `.envrc` in the shared folder that teammates otherwise cannot see;
- **use your Claude account**: spend your subscription's quota, or run up cost on your API key.

smurg cannot limit any of this: a teammate with agent access can open a terminal, and can allow whatever an agent
asks for. Everyone in the workspace sees every session live, and the audit log records who opened each session,
every message to an agent and every answer to a permission request, but that only tells you afterwards what
happened. **Give this role only to people you fully trust**, for example someone you would hand your logged-in
computer to. Make everyone else an Editor: they can edit files with you, vote on agents' questions and send
suggestions to agents, and you or someone with agent access decides whether to accept them.

- **Giving it**: share with `smurg host <folder> --role agent`, and the teammates' link it prints is an Agent access
  link; or, while sharing, create an invite link with this role or change a member's role to Agent access in the host
  console of the web app (the console shows the same warning first, and creates or changes nothing until you confirm
  that you understand).
- **Taking it back**: in the host console, change the role back to Editor or Viewer, or remove the member. They can
  no longer start anything, message agents or answer requests. The terminals and the agent sessions without a topic
  that they opened end at once. The sessions of topics they started **pass to you**: they keep running when you
  only changed the role, and are stopped first when you removed the member. What they put in place goes with them:
  the kinds of commands they always allowed, work items they started that have not begun yet, a permission mode they
  loosened, their messages that an agent has not read yet (§10.6). **This only takes back what they may do in
  smurg.** What they already did as you does not go away: see the "After taking it back" list below.
- Before you start, make sure `claude` is logged in on this computer (run `claude` in your own terminal and log
  in). An agent session has no way to log in: when Claude Code is logged out, agent sessions say so and wait until
  you have logged in in your own terminal (§8).

**After taking it back**: while they had Agent access, they could read and copy anything your account can read, and
leave things on the computer that run by themselves later. If you no longer trust them, or are not sure what they
did, do all of this:

1. **Replace the workspace's keys and invite links**: note the workspace code from `smurg status` (after stopping,
   `smurg status` no longer lists it), stop sharing with `smurg stop`, move `~/.smurg/workspaces/<workspace code>/`
   somewhere else (for example, add `.old` to its name), then share again with `smurg host`. The daemon key and the
   secrets of the invite links are all new (they may have read the old ones); your other teammates join again with a
   new invite link.
   - Teammates who joined before see "**The host computer's key has changed**" when they use the new link (the web
     app and `smurg attach` both ask before going on). Look up the new **daemon key fingerprint** with
     `smurg status` and tell them over another channel (in person, on the phone), so they can compare it before they
     continue.
   - The topics, the conversations and the audit log of the workspace are in the folder you moved: the new workspace
     starts without them. The spec, plan and report files are in the project itself and stay.
   - The old worktrees are still in `<folder>/.smurg/worktrees/`: the new workspace state does not know them,
     teammates cannot see them, and smurg can no longer merge or remove them. Review the changes you still want,
     merge them into the main workspace yourself, then delete those folders.
   - If you only stop and share again without moving that folder, the keys and the invite links that have not
     expired stay the same.
2. **Replace the relay login**: `smurg logout`, then `smurg login`. A relay login cannot be revoked early: if
   they copied the old one (`~/.smurg/credentials.json`), it keeps working until it expires (at most 7 days after
   the login).
3. **Replace your other credentials**: the Claude Code login (run `claude` in your terminal, `/logout`, then
   `/login`; with an API key, make a new key), the keys in `~/.ssh`, and the credentials of the other programs and
   cloud services in your home folder.
4. **Check the places that run things automatically**, and remove whatever you do not recognize:
   - shell startup files: `~/.zshrc`, `~/.zprofile`, `~/.bashrc`, `~/.bash_profile`, `~/.profile`;
   - scheduled jobs: `crontab -l`;
   - programs that start at login: `~/Library/LaunchAgents/` on macOS; on Linux the systemd user services
     (`~/.config/systemd/user/`, `systemctl --user list-unit-files`) and `~/.config/autostart/`;
   - `~/.ssh/authorized_keys`: an extra key lets someone log in to your computer directly, without smurg;
   - Claude Code's settings: the `hooks` and the permission rules in `~/.claude/settings.json` (your own allow rules
     apply to every agent here, §5.3), and `~/.claude/CLAUDE.md` (every later agent follows it);
   - your git projects (the shared one and the others): the scripts in `.git/hooks/`, and git settings that run
     programs, for example
     `git config --show-origin --get-regexp 'core\.(fsmonitor|hooksPath|sshCommand)'` (look at `~/.gitconfig` too);
   - programs that are still running: when a session ends, smurg ends the programs it can find, but a program that
     deliberately detached from its session may keep running under your account, and it can type into any terminal
     session, yours included, through the control socket on this computer (the one `smurg attach` uses). If you are
     not sure, restart the computer after the checks above.
5. **Logs cannot tell them from you**: what they did through a session under your operating-system account looks, in
   the logs of the system and of other programs, exactly like what you did yourself. smurg's audit log records who
   opened a session, every message sent to an agent, every answer to a permission request with the whole command,
   and every command an agent ran without a request; it does not record what was typed into a terminal session. The
   control socket on this computer (the one `smurg attach` uses) can only list sessions and attach to terminal
   sessions; it cannot message agents, answer their requests, vote, start work, change roles, approve merges, remove
   members or change settings in your name. But until you took the role back, they could do anything your
   operating-system account can do.

### 5.2 What agents do by themselves, and what they ask first

Before every single tool call of an agent, smurg's own check runs. It runs before Claude Code's own permission
system and holds whatever your Claude Code settings allow. What it lets through depends on the kind of session:

- **A topic's discussion agent** reads files inside the project (never the files of §4 that teammates cannot see),
  writes only the topic's `SPEC.md` and `PLAN.md`, and has no shell and no network tool. Its permissions are fixed
  (the session shows "Reads code, writes only the spec and the plan"). It asks the team its questions as cards.
- **A work item's agent** works in the item's own worktree. It edits files in that worktree without asking, and it
  runs read-only commands and simple file commands inside it (`ls`, `cat`, `mkdir`, `mv`, `cp`) without asking.
  Everything else asks first: any other command, anything on the network, anything outside its worktree. It cannot
  change the topic's spec or plan. This mode is called "Asks before commands"; you and members with agent access
  can make a session stricter ("Asks before edits and commands"). There is no mode that asks for nothing.
- **An agent session without a topic** in a worktree behaves like a work item's agent. In the main workspace it
  starts with "Asks before edits and commands"; with "Asks before commands" there, its file edits are allowed
  (file locks still apply, see the guide for teammates) and every shell command that writes still asks.
- **No agent** changes Claude Code's own settings (`.claude/`, `.mcp.json`) or anything in `.git`, and an agent of a
  session a teammate opened cannot change the files only you may change (`CLAUDE.md`, `.vscode/`, `.idea/`).
- When smurg itself is not reachable on your computer (it crashed, or was killed), every tool call of an agent is
  refused, so nothing runs unattended (§7).

**Permission requests.** When an agent needs something it may not do by itself, a card appears in its conversation
and in an inbox, and the agent waits. The card shows the whole command (or the whole diff of an edit, or everything
the tool was given), where it would run and Claude Code's reason. A request that is too large to show whole is
denied, never shortened.

- **Who can answer**: you and every member with agent access; Editors and Viewers see the request and cannot answer
  it. It goes first to the inbox of the session's responsible person when that person can answer it; when nobody is
  assigned, or after the waiting time (5 minutes unless you change it in the host console's settings; one minute
  when that person is offline), it is in your inbox and in that of every member with agent access. The first answer
  wins. The setting is "Waiting time before others are asked (minutes)".
- **The answers**: "Allow once", "Always allow this kind" or "Deny" (with an optional line that tells the agent
  what to do instead).
- **"Always allow this kind"** is offered for two kinds only: commands that start with two or three fixed words
  (for example `pnpm test`), and fetching from one named host. It is never offered for shells and interpreters, for
  commands that download and run code (`pnpm add`, `npx`), for a command of one word, or for a request only you may
  allow; the card says why. You choose where it applies: "in this session" or "in every session of this topic"
  (the kinds allowed for a topic are also listed in its plan, where they can be added and removed). A kind covers the
  same command after the agent changed the files it runs: an agent that may always run the tests can edit a test
  file and run what it wrote. A session's permission menu lists what is always allowed there, and each entry can be
  removed. An entry also goes away by itself when the member who added it is removed or loses agent access.
- **Requests only you can allow**: a request that smurg recognizes as reaching beyond the project (a file outside
  it, for example) says "Only the host can allow this: it reaches beyond the shared project." It is a label for what
  smurg can recognize, not a wall: a command that is allowed can still reach anywhere your account can.
- Every answer is in the audit log with the whole command, and so is every command that ran without a request (the
  entry "Agent ran a command"). That entry does not say which rule let the command through (a kind someone always
  allowed, one of your own rules, a read-only command in a worktree); a command that a topic's always-allowed kind
  answered has an entry of its own that names the kind.

### 5.3 Your own Claude Code: allow rules, MCP servers, project settings, `CLAUDE.md`

**Your own allow rules apply.** If your own Claude Code settings (`~/.claude/settings.json`) already allow some
commands without asking, they are allowed for the agents here too, exactly as in your own terminal: such a command
runs without a permission request, also when the agent works for a teammate. smurg tells you once which of your
rules apply: an inbox item, "Your own Claude Code rules apply here", opens the list; it is information, there is
nothing to confirm ("Agents here run them without asking too."). The list stays in the host console under
"My own Claude Code rules"; `smurg status` shows how many apply (§7), and you and members with agent access can
read the list in a session's permission menu. smurg learns the rules from Claude Code when an agent starts: until
the first agent session has started, the list is empty and `smurg status` says "none apply to agent sessions". When
a new rule appears later, you are told again. The list names where each rule comes from: your user settings, the
project's settings (once you confirmed them, below) or managed settings. To keep a rule from applying here,
remove it from your own Claude Code settings. The limits of §5.2 hold regardless of your rules: a discussion agent
stays without a shell, and no agent changes Claude Code's settings.

**Your MCP servers, connectors and plugins are off for agents** unless you switch them on in the host console's
settings ("Agents may use my own and this project's MCP servers"; never for a discussion agent). Think before you do: an agent that any member with agent access can
direct could then call those servers (mail, a drive, a chat), and their answers show to every member. With the
switch on, such a call is a permission request that shows everything the tool was given, and the servers of the
project's own `.mcp.json` also need the confirmation below.

**Claude Code project settings.** A shared folder can hold Claude Code settings of its own (`.claude/settings.json`,
`.claude/settings.local.json`, `.mcp.json`): they can run commands (hooks, MCP servers), change permissions and set
environment variables. In your own terminal Claude Code asks whether you trust a folder before it loads them. An
agent session in smurg never shows that question, so smurg asks you instead:

- As soon as you share a folder whose settings you have not decided about, you (and only you) have an inbox item:
  "Claude Code project settings wait for the host". It opens the review in the host console. Until you decide, the
  dialog that starts a topic shows you the same review under "This folder has Claude Code project settings": every
  command the settings run, every permission rule, every environment variable (the ones that could send your Claude
  login to another server are marked), with the files one click away. You choose "Use them" or
  "Run without them (agents will not read CLAUDE.md)"; when the settings can send your login elsewhere or let
  agents act without asking, you first tick what you have read. A teammate who starts a topic before you decided is
  told that the discussion runs without the settings until you confirm. While work items run in worktrees before
  you decided, the same item is in your inbox once for the main workspace and once for each worktree: they are about
  the same content, and one decision settles all of them.
- Until you confirm, agent sessions run without those settings, and, as Claude Code works, also without the
  project's `CLAUDE.md`; the conversation says so:
  "The host has not confirmed this folder's Claude Code project settings. This session runs without them and without the project's CLAUDE.md."
- You confirm a content, not a folder. When one of the files changes, or a script inside the folder that their
  commands call, the agents working there are stopped, and from then on they run without the settings until you
  have looked again:
  "This folder's Claude Code project settings changed. The agent was stopped until the host confirms them."
  While a content is confirmed, those files and scripts can be changed through smurg only by you. What a script
  runs in turn is not followed: anyone who can edit files in the folder can change what your confirmed commands
  end up running.
- You can look at the settings and change your decision at any time in the host console, under
  "Claude Code project settings"; a decision applies the next time a session's agent starts. `smurg status` shows
  the state for the shared folder (§7).

**`CLAUDE.md` is yours to edit.** Claude Code reads `CLAUDE.md` and `CLAUDE.local.md` as instructions, and agents
here run as you. Through smurg only you can change these files, at any depth of the folder; teammates see them
(not `CLAUDE.local.md`) and cannot change them, and no agent of a teammate's session can. A work item whose changes
touch such a file is not offered for merging from its report; you can still merge it yourself after reading the
diff (§10.3).

### 5.4 Conversations on your disk

- **Where**: `~/.smurg/workspaces/<workspace code>/transcripts/`, readable only by your account, outside the shared
  folder; no file request of a teammate reaches it. Every member reads the conversations in the web app (§4).
- **What is kept**: what a conversation showed: people's messages, the agent's text, what its tools did (commands
  with their output, edits with their diffs), questions with votes and comments, permission requests with their
  answers, suggestions. **Not kept**: the content of files an agent only read, the lines its searches matched, and
  its thinking.
- **How long**: a topic's conversations are kept as long as the topic, archived or not; deleting an archived topic
  in the web app deletes them. The conversation of an agent session without a topic is removed 30 days after the
  session ended. A single conversation is kept up to 256 MB; beyond that its oldest part goes
  ("The oldest part of this conversation is no longer kept."). When all conversations of a workspace together pass 2 GB, the oldest ended sessions without a topic
  go first; after that nothing is removed silently: you get an inbox item,
  "Conversations use more disk space than the limit", and delete archived topics yourself.
- **Removing one entry**: as the host you can remove a single entry of a conversation ("Remove this entry…" on the
  entry), for example the output of a command that printed a secret. It is deleted from the disk, and everyone sees
  "The host removed this entry." in its place. This does not undo that people already saw it, and Claude Code's own
  record of the conversation (below) still has it.
- **Claude Code's own record**: Claude Code keeps its own transcript of each conversation under `~/.claude/` on its
  own schedule (30 days by default); smurg never reads or deletes it. It is the agent's memory. When an agent is
  continued after Claude Code removed it, the conversation says
  "Claude Code no longer keeps the earlier conversation. Claude starts again from the files."
- `smurg uninstall` removes the conversations with the rest of `~/.smurg` (§9.2). The audit log is in the same
  workspace folder; it keeps the full text of what was sent to agents.

### 5.5 Notices of agents' shell commands

On by default; turn it off with `--no-bash-attribution`. The setting is fixed when sharing starts: to change it, stop
sharing and run `smurg host` with the new option (the workspace and its members for that folder are kept, and
teammates do not have to join again). `smurg status` shows whether it is on while you share (§7).

When an agent changes a file with tools such as Edit or Write, smurg knows which agent did it. When an agent changes
files with a shell command (`sed -i`, a formatter), smurg could only show the change in the activity feed as
"Outside program". Now:

- Each agent session tells the smurg on this computer when a shell command starts and when it ends. This notice
  never blocks a command: when smurg does not answer it, the command is simply not recorded under that agent.
  (Whether a command may run at all is decided before, as §5.2 describes.)
- A file that changes while **exactly one agent is running a shell command** (plus 3 seconds after the command ends),
  and that nobody else claims, is recorded as changed by that agent, for example "Claude (Amy) changed src/app.ts
  with a shell command"; the audit log says the same. While two or more agents are running shell commands, the
  change still shows as "Outside program".
- Known limit: if you change a file in the same area with a tool outside smurg (another editor, your own terminal)
  while an agent is running a shell command, the change is also recorded as that agent's.
- The cost: two small programs run for every shell command, about 0.05 seconds each on the development machine.

With the setting off, files that agents change with shell commands show as "Outside program" in the activity feed.
File locks and conflict handling are not affected by this setting.

## 6. Keeping the computer awake

While sharing, smurg keeps the computer from going to sleep **when idle** (macOS: `caffeinate`; Linux:
`systemd-inhibit`). **Closing a laptop's lid still puts it to sleep**; teammates then see "Host offline". When the
computer cannot be kept awake (for example, Linux has no `systemd-inhibit`), or that stops working later,
`smurg host` prints a warning in the terminal; with `--no-keep-awake` it prints nothing. `smurg status` shows the
current state (the "Keep-awake" line).

When you start `smurg host` over SSH on Ubuntu, the system (polkit) does not allow keeping the computer awake by
default, and `smurg host` prints "Warning: keep-awake: off (the system (polkit) does not allow blocking sleep, …)"
(verified on Ubuntu 24.04; other distributions, or an organization's own polkit rules, may refuse too, with the same
message). To keep
the computer awake, start `smurg host` after logging in on that computer's desktop; a server without a desktop
usually does not go to sleep by itself anyway.

## 7. Status and stopping

```sh
smurg status          # the workspaces this computer is sharing (see below)
smurg stop            # stop sharing: disconnects everyone, ends terminal sessions, pauses agent sessions
```

`smurg status` lists every workspace being shared (everything `smurg host` does not print at start is here):

- the workspace code, the shared folder, the relay's address (it says when that is the shared relay) and the
  connection state, the number of connections and the members online;
- the **daemon key fingerprint** (§3);
- keep-awake (§6);
- notices of agents' shell commands (on or off, §5.5);
- "Claude Code": its version, whether this smurg was verified with it or it is too old for agent sessions, and
  whether it is logged in ("not checked yet (smurg checks it when the first agent session starts)" until then);
- "Agent sessions": how many are running, waiting for a person, stopped without a report or failed, and idle;
- "Topics": how many there are, and how many are paused (§10.5);
- "Claude Code project settings": "confirmed (agents use them)", "not confirmed (agents run without them; confirm them in the web app)" or "none in this folder" (§5.3);
- "Your own Claude Code allow rules": how many apply to agent sessions (§5.3);
- where the daemon's log is: `~/.smurg/logs/<workspace code>.log` (mode 0600, no invite links in it). When
  something goes wrong, the details are there.

Pressing Ctrl-C in the terminal of `smurg host` does the same as `smurg stop` (stopping takes a few seconds;
pressing again within 2 seconds does not interrupt it, and pressing once more after that ends it at once, possibly
before everything has stopped).

**What a stop does to sessions.** Terminal sessions end. Agent sessions are paused: their agents stop, their
conversations are kept, and smurg says how many there are, for example
`3 agent sessions are paused. They continue when you share this folder again.` When you share the folder again,
every conversation is readable and every agent is idle; a plan that had work running or waiting to start is paused.
Nothing runs by itself: a paused plan goes on when you or a member with agent access presses "Continue all"
(§10.5), and a discussion or a session without a topic goes on with its next message. An agent that was in the
middle of its work says so:
"smurg was restarted on the host's computer. The agent's turn was interrupted."

If `smurg host` ends without stopping properly (a crash, a kill, the computer losing power), the agents' own
processes may outlive it for a moment. They cannot do anything: every tool call of an agent is checked with smurg
first and is refused while smurg is gone. An agent can still receive some text from the model until its turn ends,
which is usage on your account. After the next start smurg ends what is left, and the conversation says
"smurg stopped while this agent was working. The agent may have gone on for a moment by itself: check its changes."

While sharing, `smurg host` tells you in the terminal when the connection to the relay is lost and when it is back,
when the relay refuses your login (it expired; teammates cannot connect), when your login is about to expire
(within 24 hours), and when smurg's state file cannot be written. When the login has expired or is about to, run
`smurg login` in **another terminal** (with the same account; if the relay you share through is not the one you last
logged in to, add `--relay <its address>`): `smurg host` switches to the new login within seconds, and you do not
have to share again.

To attach to a terminal session in your own terminal: `smurg attach` (lists the terminal sessions, then the agent
sessions with their topic and status), `smurg attach <number>`; Ctrl-] detaches. Agent sessions are conversations:
they open in the browser, not in a terminal.

## 8. Troubleshooting

| You see | Cause and what to do |
|---|---|
| "Cannot reach the relay" / "the relay refused the request"; teammates see "Server unreachable" | Check your network first. On the shared relay, today's free quota may also be used up (§2.1): it comes back after 00:00 UTC (08:00 in Taiwan). |
| "This folder is already being shared" / "A folder above this one is already being shared" | Only one `smurg host` can share the same files at a time (whatever the relay). Look with `smurg status`, or stop it with `smurg stop`. |
| "the relay refused this computer's login" | Your relay login expired or is no longer valid. Run `smurg login` in another terminal (§7); `smurg host` reconnects by itself. |
| At login: "The code expired; the login did not complete" | The code was not entered and allowed in a browser within 10 minutes. Run the command again (§2). |
| The page where you enter the code says "That code is not correct or is no longer valid." / "Too many wrong codes." | Make sure it is the **newest** code in the terminal (8 letters, no digits). A code stops working once it was used, denied or expired; after too many wrong codes you wait a few minutes (the page says how long). |
| "This relay does not support logging in with a code yet" | The relay you named with `--relay` is older than your smurg. Ask whoever runs that relay to update it. |
| "smurg's state file could not be written" | The disk is full or a permission is missing. The change you just made (removing a member, changing a role, revoking an invite) is in effect now, but if you stop sharing before a write succeeds, it is gone after the restart. |
| "This workspace's state files were written by another smurg version, or are not in the expected format; the daemon refused to start" | The workspace state for this folder (`~/.smurg/workspaces/<workspace code>/`) cannot be read: usually another version of smurg wrote it (smurg does not convert other versions' state); another program may also have changed it, or its permissions are wrong. Which file and why is in the log file the terminal names. What to do: move that folder somewhere else (for example, add `.old` to its name) and run `smurg host` again. That creates a new workspace state: the earlier members, invite links, topics and conversations are no longer there, and teammates join again with a new invite link. The daemon key is new too: teammates who joined before see "The host computer's key has changed", so tell them the new key fingerprint from `smurg status` over another channel (§5.1 "After taking it back", step 1, which also covers the old worktrees). |
| A teammate says they see "The host computer's key has changed" | You replaced the workspace's keys (§5.1 "After taking it back", step 1, or the row above): look up the new daemon key fingerprint with `smurg status` and tell them over another channel (in person, on the phone), so they can compare it before they continue. If you did not replace anything, tell them not to continue: someone may be posing as you. |
| "The path of smurg's state folder is too long for a Unix socket" | Set `SMURG_HOME` to a shorter path (the path of a Unix socket has a length limit). |
| Teammates see "Host offline" | `smurg host` is not running, or the computer is asleep or has no network. |
| A topic or an agent session cannot be started: "Claude Code is not logged in on the host's computer, so no agent session can be started. The host must run `claude` and log in." (a session that is already open says "Claude Code is not logged in on the host's computer.") | Every agent uses your Claude Code login on this computer (§5.1). Run `claude` in your own terminal and log in; nobody can log in from inside a session. Then choose "Check login again" in the session, or send the next message. |
| "Anthropic rejected the host's Claude Code login. The host must log in again in their own terminal." | The login on this computer is no longer accepted. Run `claude` in your own terminal, log out and log in again. |
| An agent session cannot be started, and the sentence ends with "The host should update Claude Code." | Agent sessions need Claude Code 2.1.288 or later (§1); the sentence names the version it found. Update Claude Code (`claude update`, or the way you installed it). `smurg status` shows the version smurg sees. |
| "The claude command was not found on the host." / "Claude Code did not answer when the session started. The host should check that `claude` runs in a terminal on their computer." | Claude Code is not installed for your account, is not in the `PATH` that `smurg host` was started with, or does not start. Run `claude` in the terminal you start `smurg host` from. A session that failed has "Try again"; after three failed starts only you can try again. |
| "The host's Claude account has reached a usage limit." (your inbox: "The host's Claude account reached a usage limit") | The account `claude` is logged in to has no usage left for now. Every agent waits, and the web app says when the limit resets if Claude Code reports it. Whether the work then goes on by itself is up to Claude Code (smurg starts nothing again, and this was not tried with a real account): if an agent stays where it was, send it a message. Many agents working at once use a subscription's allowance quickly (§10.4). |
| A work item says "Stopped without a report" | Its agent ended its turn without writing the result report, although smurg asked it once more ("smurg asked Claude for the result report"), or someone stopped it. Open the session to see where it stands; "Continue" asks the agent to go on. |
| A work item says "Failed" (your inbox: "the agent's process failed"), or its session shows "The agent's process ended unexpectedly" | Claude Code's process ended. "Try again" continues the same conversation. If it keeps failing, look at the daemon's log (§7). |
| A work item says "The plan changed: Start again" (your inbox: "did not start"): "The spec or the plan changed since Start. This item did not start." | A work item starts only from the spec and the plan that someone confirmed when they pressed Start (§10.2). Open the plan, look at what changed and press "Start again" on the item. |
| Start is refused: "Work items run in git worktrees, and this folder is not a git repository yet. The host can make it one: run `git init`, then commit once." | Do that in the shared folder, in your own terminal (§10.2). |
| Start is refused: "The spec and the plan could not be committed: git is in the middle of another operation in the main workspace." | Finish or abort the merge or rebase in the shared folder, then press Start again. |
| A work item waits although nothing seems to run (the plan says "Waiting for a free agent") | The limit of work items that run at once is reached (§10.4), often because several of them wait for a person: answer the questions and permission requests in the inbox, or raise the limit in the host console's settings ("Work items running at the same time"). |
| An agent session cannot be started, and the sentence ends with "Try again when one is idle." | This computer already runs 32 agent processes, the fixed limit of one `smurg host`; it is not a setting. smurg puts an idle agent's process aside by itself to make room, but an agent that is working or waiting for a person keeps its process: answer what waits in the inbox, or end sessions you no longer need. |
| A teammate cannot start a topic or open a session | Only Agent access can (§5.1). To give it, change their role in the host console; read the risk in §5.1 first. |
| Files an agent changed with a shell command show as "Outside program" in the activity feed | You started sharing with `--no-bash-attribution`, or two or more agents were running shell commands at the same time, so smurg cannot tell which one it was (§5.5). |
| A new folder shows as "Outside program" in the activity feed and the audit log, although an agent, a merge or smurg itself created it | smurg attributes files, not folders: every new folder is recorded that way (a topic's folder under `specs/`, a folder an agent creates in its worktree, a folder a merge brings into the main workspace). The files in it are attributed to whoever wrote them. |

All state (keys, logins, workspaces, conversations, log files) is in `~/.smurg` (`SMURG_HOME` changes the place);
the log files are in `~/.smurg/logs/` and contain no invite links.

## 9. Updating and removing

### 9.1 Update: `smurg update`

```sh
smurg update --check    # only check for a new version; download nothing
smurg update            # update to the newest version
```

- `smurg update` first reads `https://downloads.smurg.ai/latest/VERSION`. When a version newer than yours exists, it
  downloads this computer's executable and that version's `SHA256SUMS` from `https://downloads.smurg.ai/v<version>/`,
  and replaces the current executable in place only when **the sha256 matches**, the file really is that version and
  it runs on this computer. Then it prints the old version, the new version and the address of the changelog
  (https://smurg.ai/docs/changelog/). When you already have the newest version it does nothing, and it never
  replaces the executable with an older version.
- **You cannot update while sharing**: `smurg update` asks you to run `smurg stop` first; it does not stop sharing by
  itself. The reason: the daemon that is still running is the old version, while the `smurg` command that agent
  sessions call is already the new one, and the two versions together can go wrong.
- **Read the changelog before you update.** A new version may not read the workspace state an older one wrote
  (members, invite links, topics, conversations): smurg does not convert it, and the changelog says so when it
  happens (§8 has the row for it). Your `smurg`, the web app (the relay's version) and every `smurg attach` must
  be the same version.
- If the download fails, the sha256 does not match or you press Ctrl-C, the current executable is left untouched and
  the partly downloaded temporary file is deleted.
- When the folder that holds the executable is not writable (for example, it was not installed by the installer), it
  says which folder: update the way you installed, or run the install line of §1 again.
- You trust what the installer trusts: `SHA256SUMS` is not signed, so it rests on https and on downloads.smurg.ai
  itself.
- The environment variable `SMURG_INSTALL_BASE_URL` (for tests or a mirror) downloads from that address instead.
  Only https is accepted.

**New-version notice**: after `smurg host` has printed the two links, it asks `https://downloads.smurg.ai` once, in
the background, for the newest version (a single request that carries no data, waiting 2 seconds at most). When a new
version exists, it prints one more line under the links:

```text
Version 0.5.1 is available (this is 0.5.0): stop sharing, then run smurg update
```

When there is no new version, or the check fails or times out, it prints nothing and sharing is not affected. To turn
the check off, set the environment variable `SMURG_NO_UPDATE_CHECK=1`. Automated environments (`CI` is set, or smurg
is not running in a terminal) never check.

### 9.2 Remove: `smurg uninstall`

```sh
smurg uninstall               # lists what it will remove, then removes it after you confirm
smurg uninstall --keep-data   # keeps ~/.smurg; removes only the executable and the cache
```

It removes:

- the executable itself (`~/.local/bin/smurg` when the installer installed it);
- the cache: the native modules unpacked from the executable (macOS: `~/Library/Caches/smurg`; Linux:
  `~/.cache/smurg`; with `SMURG_CACHE_DIR` set, the `native-…` folders in that directory);
- the state folder `~/.smurg` (or `SMURG_HOME`): logins, the device key, every workspace's keys, members and
  invite links, the conversations of agent sessions, log files. Afterwards the members and invite links of the
  workspaces you shared no longer work. `--keep-data` keeps it.

It does not touch:

- **the `.smurg/` folder inside a project folder**: the worktrees and the changes not merged yet are in there.
  `smurg uninstall` only lists the ones it knows about; whether to delete them is up to you.
- the spec, plan and report files of your topics: they are files of the project (`specs/` in the shared folder).
- shell startup files: the installer only told you to add `~/.local/bin` to your `PATH`; it never changed your
  files. Remove the line you added yourself.

Before it does anything, it lists every path it will remove with its size and asks "Remove these? [y/N]"; it
removes them only when you type `y`. `--yes` does not ask; outside a terminal `--yes` is required, otherwise it only
prints the list and ends. A workspace that is being shared is stopped first (as `smurg stop` does); if it cannot be
stopped, nothing is removed. When `SMURG_HOME` points somewhere that must not be deleted (`/`, your home folder, or a
folder holding things smurg did not create), it refuses: use `--keep-data` then, and deal with that folder yourself.

When you run smurg from source: delete the three places above yourself.

## 10. Topics from the host's side

The guide for teammates (§6 there) walks through a topic from the discussion to the reviewed result. This section
is what a topic asks of you as the host.

### 10.1 What only you can do

- **Merge.** Every work item's changes reach the main workspace only when you merge them (§10.3).
- **Confirm the folder's Claude Code project settings** (§5.3), and edit `CLAUDE.md`.
- **Allow the requests that reach beyond the project** (§5.2).
- **Change the host settings** in the host console: how many agents may work at once (§10.4), how long a question
  or a request waits before the others are asked too (§10.6), whether agents may use your own MCP servers (§5.3),
  the folders shared into worktrees.
- **Try again after three failed starts** of a session, terminate any session, delete an archived topic, remove one
  entry of a conversation (§5.4).

You, and every member with agent access, can also do everything a topic needs from day to day: create it, ask for
the plan, press Start, answer permission requests, continue after a restart. A question an agent asks is decided by
the session's responsible person, or, when nobody is assigned, by whoever opened the session or pressed Start; as
the host you can always submit an answer too.

### 10.2 Start: git, and the commit smurg makes

- **Work items need git.** Each work item runs in its own git worktree, so the shared folder must be a git
  repository with at least one commit (`git init`, then commit once), and git must be 2.42 or later. Without that,
  everything up to the plan works, and Start says what is missing.
- **Start shows what it will do before it does it**: which items start now and which wait for others, who is
  responsible for each, who edited the spec and the plan by hand since the last Start, and the commit below. Read
  it: it is the moment the team's text becomes instructions for agents that run as you.
- **smurg commits the spec and the plan for you.** A worktree contains only what is committed, so when someone
  presses Start, smurg commits exactly two files, the topic's `SPEC.md` and `PLAN.md`, to the branch you have checked
  out in the shared folder (the dialog names it), in the name of the member who pressed Start, with the message
  `smurg: spec and plan of <topic folder>` and one `Edited-by:` line per person who edited them by hand. Nothing
  else in the folder is committed, staged or changed, and none of your repository's git hooks runs. Start is
  refused while the repository is in the middle of a merge or a rebase, or when git ignores the topic's folder.
- **Agents start only from what was confirmed.** A work item that waits for others starts by itself later, when the
  items it depends on are merged, and only while the spec and the plan are still exactly the ones that were
  committed at Start. If either file changed since (an Editor fixed a typo, the plan was updated), the item does
  not start: the person who pressed Start and you get an inbox item, look at the change and start it again.
- **Each work item has its own branch**, `smurg/<topic folder>/<item id>`, in a worktree under
  `<folder>/.smurg/worktrees/`. The agent does not commit; smurg commits the item's changes when its report is
  written, in the name of the member who started the item, with the message `smurg: work item <number> (<item id>)`.
- A fresh worktree has no `node_modules` and nothing else that git does not track. Name the folders that should be
  shared into every worktree (read-only for people there) in the host console's settings, or let the agents
  install first.

### 10.3 Merging, and what waits for it

- When a result report has been reviewed, its changes are in your inbox by themselves, as
  "Reviewed, ready to merge", with the items that wait for it. A member with agent access can also ask you to merge
  work that nobody reviewed.
- You read the complete diff, then choose "Merge into the main workspace" or "Reject". The merge commit is yours and
  says whose work it was (`Merge smurg/<topic folder>/<item id> (<name>)`: the member who asked for the merge, else
  the one who started the item).
- **Work items that depend on others start only after you merged those.** In a plan with dependencies, you are the
  one everybody waits for: the plan says which items wait for a merge, and the inbox puts the merges that unblock
  something first.
- Changes that smurg will not offer from a report: ones that contain files only you may change (`CLAUDE.md`,
  `.claude/`, `.envrc` and the like), that touch the topic's own `SPEC.md` or `PLAN.md`, or that contain a link
  pointing out of the project. The report says why, for example
  "The changes cannot be shown: the worktree contains files only the host may change."
  You can still request the merge yourself in the web app and read the diff before you decide.
- **A conflict** stops the merge and leaves the main workspace as it was. You or a member with agent access can
  then ask the item's agent to resolve it: smurg itself merges the main workspace into the item's worktree (no agent
  runs git, and none of your git hooks or git settings is used), the agent resolves the marked places and writes a
  new version of the report, and the merge is offered again. Files of the worktree that git does not track are
  never overwritten by this.
- Everyone can read the diff of a report. A file that teammates cannot see (§4) is listed there without its content
  for everyone but you, and text that looks like a credential is shown as `[masked]` to everyone.
- A work item that is merged and reviewed is finished: its session ends, its worktree is removed, its conversation
  and its report stay readable. Archiving a topic lists the work items whose changes were never merged and asks
  whether to keep or delete them.

### 10.4 How many agents work at once, and memory

- One Claude Code process runs per agent that is working or waiting for a person. On the development machine a
  fresh one took about 260 MB of memory, and one with a long conversation 400 to 600 MB.
- smurg therefore limits how many work items run at once: 8 by default, fewer on a computer with little memory
  (about one per 3 GB, at least 2). You change the limit in the host console's settings
  ("Work items running at the same time"). A work item that waits for a free agent says so in the plan, with how
  many of the working agents are waiting for a person.
- An agent that is idle gives up its process after a while and gets a new one with its next message; the
  conversation continues where it was. An agent that waits for an answer or for permission keeps its process: an
  unanswered inbox holds agents, and memory, back.
- smurg shows no token counts and no cost. Several agents working at once use your Claude account several times as
  fast as one; look at the usage where your Claude account shows it.

### 10.5 After a restart: "Continue all"

After `smurg host` was stopped and started again (also after a crash or a restart of the computer), nothing runs
by itself:

- every conversation is readable, every agent session is idle;
- every plan that had work in progress is paused: the web app shows it on top of the sessions view
  ("smurg was restarted on the host's computer."), and you and the members with agent access have one inbox item
  per topic;
- "Continue all" lets the plan go on: the agents that were interrupted are told to continue, and work items that
  were waiting can start again. A question or a permission request that was open before the restart is asked again
  when its session continues; the votes and comments of the earlier card stay readable.

### 10.6 When someone does not answer, leaves or is removed

- **Nobody answers.** A question or a permission request that has waited for the waiting time (5 minutes by
  default; 1 to 60 minutes in the host console's settings), or whose person has been offline for a minute, also
  appears in your inbox and in that of every member with agent access. You can then answer in that person's place
  ("Submit for Ian"); the conversation records that you did. A result report nobody reviewed does the same after
  six times that long.
- **A member leaves the workspace, or you change their role** so that they can no longer use agents: their
  terminals and their agent sessions without a topic end. The sessions of topics pass to you and keep running
  ("Amy left. This session now runs for the host."). When they left or are now a Viewer, whatever they were
  responsible for is decided by the next person in line: whoever opened the session or pressed Start, or you. A
  member you made an Editor stays responsible for what they had.
- **You remove a member**: the same, but their topic sessions are stopped first
  ("Amy was removed. This session was stopped and now runs for the host."). A member who is removed and joins again
  does not get their old sessions back.
- In all these cases what they put in place goes with them: the kinds of commands they always allowed are removed,
  a permission mode they loosened returns to its default, and work items they started that have not begun do not
  start until someone starts them again. A session that passed to you keeps the limits it was created with: its
  agent still cannot change the files only you may change.

### 10.7 Long discussions

A topic's discussion is one conversation that everyone shares, and it can get long.

- When it no longer fits, Claude Code shortens the earlier part by itself (a pause you can see, then
  "Claude Code shortened the earlier conversation to make room."). The spec and the plan are files, so what was
  decided is not lost.
- A long conversation costs more with every turn, and after the team has deliberated for a while without the agent,
  the next turn reads the whole conversation again, on your account.
- A long discussion therefore offers "Start a fresh conversation": the topic gets a new discussion that starts from
  the spec and the plan as they are now. The earlier one stays readable.
- If a topic's discussion can no longer be used at all (it was terminated, or it failed to start three times), you
  and the person who created the topic get an inbox item with "Restart discussion". The files and the work items
  are not touched by that.

### 10.8 What was verified, and what was not

The flow of this version (discussion with questions and votes, spec, plan, work items, result reports, review,
merge) was verified by smurg's developers against a scripted stand-in for the model, and real Claude Code (version
2.1.288, the oldest that agent sessions accept) was run only against a fake API on the development machine. That
machine is a Mac: real Claude Code was not run with smurg on Linux at all for this version; on Linux only the
stand-in was tested. No real Claude account was used for testing. So how a real
model behaves in this flow is not verified yet: whether it asks its questions as cards as it is told, writes the
plan and the report in the format smurg checks, and proposes a sensible split of the work. This may need tuning in
later versions.

What bounds the damage when an agent does not behave: smurg checks the plan and the report format itself and asks
the agent to fix them (at most twice in a row), asks once for a missing report, and puts work that stopped into
someone's inbox instead of letting it stop unseen. Watch your first topic with a real project closely, and if a
step of the flow does not work with your Claude Code, report it at https://github.com/gclinian/smurg.
