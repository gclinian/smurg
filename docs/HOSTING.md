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
- Running the install line again also installs the newest version over the one you have. When the smurg it is about
  to replace is sharing a workspace, the installer stops and installs nothing: stop sharing first (`smurg stop`), as
  for `smurg update` (§9.1). `curl -fsSL https://smurg.ai/install.sh | sh -s -- --force` installs all the same; a
  `smurg host` that is still running must then be stopped and started again.
- To run agents, this computer also needs the `claude` command (Claude Code **2.1.288 or later**), **already logged
  in** to your Claude account: every agent session uses this computer's login, whoever in the workspace it works for
  (§4, §5.1). An older Claude Code is refused for agent sessions; with a newer one than this smurg was verified
  with, agent sessions run and you get one notification that says so. `smurg status` shows which it is (§7).
- To let agents carry out work items, the folder you share must be a **git repository** with at least one commit,
  and this computer needs git 2.42 or later (§10.2). Without git, a topic's discussion, spec and plan still work.
  The folder can become a repository while you share it (§10.2).
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
- The relay also serves the web app. As with any end-to-end encryption in a browser, a relay that served a tampered
  app could read what that browser decrypts, and its keys. The `smurg` command loads no code from the relay.

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
and the web app, your `smurg` and every `smurg attach` must speak the same protocol version (§9.1): deploy your own
relay again whenever you update smurg, before you share again.

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
(§7); when a new version exists, one more line appears under the links (§9.1). The first time you share after an
update, one line above the links says that the workspace was carried over (§9.2).

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
  does not stop you; it tells you in three places. The dialog that starts a topic says it to you (a teammate reads
  there only that the agent uses the host's account):
  "A personal Claude subscription (Pro or Max) is for your own use. When other people work with agents here, use an API key or a Team or Enterprise plan."
  The host console's security notes say it again:
  "Agents here use your Claude Code login. A personal Pro or Max subscription is for your own use: when other people work with agents here, use an API key or a Team or Enterprise plan."
  And the first time an agent starts while Claude Code reports a Pro or Max login and the workspace has members
  besides you, you (and only you) get a notification in the web app. It comes once for the workspace, not each
  time you share; when no window of yours is open at that moment, it arrives when you next open the workspace.
  Until you press "Got it" or close the page, it also stands in the host console, above the list of sessions:
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
- **A teammate cannot rename or delete a folder that holds a file only you may change**, at any depth below it:
  `.claude`, `.git`, `.vscode`, `.idea`, `.mcp.json`, `.envrc`, `CLAUDE.md` or `CLAUDE.local.md`. Moving the folder
  would move those files with it. This reaches folders you may not expect: `node_modules`, for example, when a
  package in it ships a `CLAUDE.md` or a `.vscode` folder. The teammate is told
  "Only the host can change this path."
  and you rename or delete such a folder yourself. smurg looks through the folder on disk to decide; a folder
  with more than 100,000 entries is refused without looking further.

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
  only changed the role, and are stopped first when you removed the member. The worktrees they had kept, with the
  changes in them, pass to you as well: they can no longer remove them, and you decide what becomes of the changes.
  What they put in place goes with them: the kinds of commands they always allowed, work items they started that have not begun yet, a permission
  mode they loosened, their messages that an agent has not read yet (§10.6). **This only takes back what they may
  do in smurg.** What they already did as you does not go away: see the "After taking it back" list below.
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
   - At its first start the new workspace names the folder you moved, in one line that begins
     "An earlier state folder of this workspace lies beside the one in use". The line is also there for hosts who
     moved a folder because smurg 0.5.0 told them to (§9.4). You moved yours on purpose: leave it where it is, never
     move it back (the keys you wanted to replace are in it), and delete it once you no longer need its
     conversations and its audit log.
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
  Everything else asks first: any other command, anything on the network, anything outside its worktree. One kind
  of file command asks even here: one that could change a script your confirmed project settings run (§5.3). It
  cannot change the topic's spec or plan. This mode is called "Asks before commands"; you and members with agent
  access can make a session stricter ("Asks before edits and commands"). There is no mode that asks for nothing.
- **An agent session without a topic** in a worktree behaves like a work item's agent. In the main workspace it
  starts with "Asks before edits and commands"; with "Asks before commands" there, its file edits are allowed
  (file locks still apply, see the guide for teammates) and every shell command that writes still asks.
- **No agent** changes Claude Code's own settings (`.claude/`, `.mcp.json`) or anything in `.git`, and an agent of a
  session a teammate opened cannot change the files only you may change (`CLAUDE.md`, `.vscode/`, `.idea/`).
- **No agent starts subagents in this version.** Claude Code's tool for that is not offered to an agent session,
  and smurg refuses it if it is called; the agent definitions in `.claude/agents` are not used. The reason: a
  subagent works with the permission mode its own definition names, not with the one smurg set for the session, so
  a definition could let edits and file commands run unasked in a session that asks before everything.
- **A message cannot hand an agent a file.** In your own terminal, Claude Code replaces `@path` in what you type
  with that file's content. Here it does not: smurg sends every message as text composed by a program, so `@path`
  stays plain text. A file reaches an agent only through the agent's own tools, where the limits above and the
  permission requests apply. To show an agent a file, name its path: it reads the file itself.
- When smurg itself is not reachable on your computer (it crashed, or was killed), every tool call of an agent is
  refused, so nothing runs unattended (§7).

**Permission requests.** When an agent needs something it may not do by itself, a card appears in its conversation
and in an inbox, and the agent waits. The card shows the whole command (or the whole diff of an edit, or everything
the tool was given), where it would run and Claude Code's reason (smurg's own reason when it is smurg that asks,
§5.3). A request that is too large to show whole is denied, never shortened. Nothing is left out of what is shown:
a character nobody can see (an invisible or zero-width character, one that changes the direction of the text, a
control character) is written out as a mark you can see, in a command for example as `<U+202E>`. A long command or
diff stands in a box that scrolls; the card says how many lines it has, and the two buttons that allow stay
disabled until every such box was scrolled to its end:
"Allow is available once you have scrolled to the end of what is asked."

- **Who can answer**: you and every member with agent access; Editors and Viewers see the request and cannot answer
  it. It goes first to the inbox of the session's responsible person when that person can answer it; when nobody is
  assigned, or after the waiting time (5 minutes unless you change it in the host console's settings; one minute
  when that person is offline), it is in your inbox and in that of every member with agent access. The first answer
  wins. The setting is "Waiting time before others are asked (minutes)".
- **The answers**: "Allow once", "Always allow this kind" or "Deny" (with an optional line that tells the agent
  what to do instead).
- **"Always allow this kind"** is offered for two kinds only: commands that start with two or three fixed words
  (for example `pnpm test`), and fetching from one named host. It is never offered for shells and interpreters, for
  commands that download and run code (`pnpm add`, `npx`), for a command of one word, for a command made of several
  (`pnpm test && git push`: a kind names one command), or for a request only you may allow; the card says why. You
  choose where it applies: "in this session" or "in every session of this topic"
  (the kinds allowed for a topic are also listed in its plan, where they can be added and removed). A kind of a
  topic answers a waiting request of another session by itself only when that request is one plain command of the
  kind (nothing chained, piped or redirected, no variable and no substitution in it), or a fetch from the kind's
  host whose address is at most 2,048 characters long. A kind covers the
  same command after the agent changed the files it runs: an agent that may always run the tests can edit a test
  file and run what it wrote. A session's permission menu lists what is always allowed there, and each entry can be
  removed. An entry also goes away by itself when the member who added it is removed or loses agent access.
- **Requests only you can allow**: a request that smurg recognizes as reaching beyond the project (a file outside
  it, for example) says "Only the host can allow this: it reaches beyond the shared project." So does a command of
  several parts that names `.claude`, `.git` or `.mcp.json`, and a command that writes where a script of your
  confirmed project settings is (§5.3). It is a label for what smurg can recognize, not a wall: a command that is
  allowed can still reach anywhere your account can.
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
stays without a shell, no agent changes Claude Code's settings, and a command that could change a script of the
project settings still asks (below).

**Your MCP servers, connectors and plugins are off for agents** unless you switch them on in the host console's
settings ("Agents may use my own and this project's MCP servers"; never for a discussion agent). Think before you do: an agent that any member with agent access can
direct could then call those servers (mail, a drive, a chat), and their answers show to every member. With the
switch on, such a call is a permission request that shows everything the tool was given, and the servers of the
project's own `.mcp.json` also need the confirmation below.

**Claude Code project settings.** A shared folder can hold Claude Code settings of its own: the three settings
files (`.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`) and everything else below `.claude/`
(agents, skills, commands, rules). They can run commands (hooks, MCP servers), change permissions and set
environment variables. In your own terminal Claude Code asks whether you trust a folder before it loads them. An
agent session in smurg never shows that question, so smurg asks you instead:

- As soon as you share a folder whose settings you have not decided about, you (and only you) have an inbox item:
  "Claude Code project settings wait for the host". It opens the review in the host console. Until you decide, the
  dialog that starts a topic shows you the same review under "This folder has Claude Code project settings". A
  teammate who starts a topic before you decided is told that the discussion runs without the settings until you
  confirm. While work items run in worktrees before you decided, the same item is in your inbox once for the main
  workspace and once for each worktree: they are about the same content, and one decision settles all of them.
- **What the review lists.** For each of the three files: every command it runs, every permission rule, every
  environment variable, and the files of the folder that its commands name (their scripts), with the file itself
  one click away. A variable that could send your Claude login to another server is marked, and so is one that
  changes which programs run (`PATH`, `NODE_OPTIONS` and the like). A character nobody can see is written out, for
  example as `<U+202E>`. A fourth entry, "Everything else in .claude/", names every other file below `.claude/` and
  what those files declare by themselves (hooks, allowed tools, a permission mode).
- **When the lists do not show everything**, the review says so. A list that is too long, or an entry that is cut
  short, has a note above it. A command whose files smurg cannot follow has a line under it, and the note above
  the lists counts such commands, for example
  `smurg cannot follow which files 2 of these commands run: only the scripts listed are guarded.`
  That is a command in which the program, or the script it is given, is a variable, a wildcard or a text the
  command builds (`sh $SCRIPT`, `eval`). It is also a command written as nobody writes one, which smurg does not
  read to its end: more than sixteen wrappers in a row (`env`, `sudo`, `nice`, `timeout`, `command`, `exec`,
  `nohup`, `xargs`; fewer when a very long word follows them), or an `eval` or `sh -c` inside another more than
  three deep. smurg guards only the scripts it could list, so read the files themselves before you decide. Using
  the settings then takes one more tick:
  "The lists above do not show everything. I have read the files themselves."
- **Your choice** is "Use them" or "Run without them (agents will not read CLAUDE.md)". When the settings can send
  your login elsewhere or let agents act without asking, you first tick what you have read. Some settings cannot
  be used as they are, and the review says why at the top of "Other settings": for example a link below
  `.claude/`, more than 2,000 files there, more than 20 scripts, or a script whose name has a backslash in it.
- Until you confirm, agent sessions run without those settings, and, as Claude Code works, also without the
  project's `CLAUDE.md`; the conversation says so:
  "The host has not confirmed this folder's Claude Code project settings. This session runs without them and without the project's CLAUDE.md."
- **You confirm a content, not a folder.** smurg watches the settings files, the scripts and the folders above
  them. When one of them changes, is replaced or is moved (also by a merge into the main workspace), the agents
  working in that folder are stopped, and from then on they run without the settings until you have looked again:
  "This folder's Claude Code project settings changed. The agent was stopped until the host confirms them."
- **The scripts are yours while the settings are in use.** Through smurg only you can change the settings files
  and the scripts: no teammate, no agent's edit tools, and no merge that a teammate or a work item asks for. A path
  that a command names where no file is yet (an optional script, a build output such as `dist/hooks/check.js`) is
  guarded in the same way: only you can create it through smurg, and the file appearing counts as a change. The
  review marks such a path "named, not there yet". A hook that runs a build output therefore asks you again after
  each build that creates it.
- **Agents' shell commands near those scripts.** While the settings in use name scripts, smurg reads every shell
  command of an agent in that folder before it runs, also in a work item's worktree, where simple file commands
  otherwise run without asking. A command line handed to another shell (`sh -c '…'`) is read like the line
  itself. A person is asked in the two cases below, and the card gives smurg's reason, in the reader's language,
  where it otherwise gives Claude Code's. No kind that someone always allowed covers such a command, and neither do
  your own allow rules: it asks each time. The check leaves alone a command that only reads a script (`cat`,
  `grep`, `diff`), one that writes a file beside it, and any other program as long as it names no script and no
  folder of one (`npm test`, or git's `status`, `diff`, `log`, `add` and `commit`).
  - The command writes where a script is: the script itself, anything below it, or a folder above it
    (`> scripts/lint.sh`, `cp x/lint.sh scripts/`, `mv scripts scripts.old`), also through a wildcard that can
    match one of them (`rm scripts/*.sh`). Only you can allow that. The card says:
    "smurg asks because this command changes a place where this folder's Claude Code project settings keep a script they run (the script itself, or a folder that holds it). Those scripts run as the host."
  - smurg cannot tell. A file command writes to a place smurg cannot read: a variable, a substitution, names that
    come out of another program (`xargs rm`), a relative name after a change to a directory it does not know. A
    program is handed a script or its folder by name, as a word of its own or glued to an option
    (`sh scripts/lint.sh`, `sort -oscripts/lint.sh`, `git diff --output=scripts/lint.sh`). It is one of git's
    commands that bring files into the working tree without naming them (`checkout`, `switch`, `restore`, `reset`,
    `stash`, `merge`, `rebase`, `pull`, `cherry-pick`, `revert`, `apply`, `am`, `clean`). Or the line is more than
    smurg follows: a shell inside a shell more than four deep, more than 16 changes of directory, more than 256
    places named. You or a member with agent access can allow that, also when a line smurg could not follow does
    write a script. The card says:
    "smurg asks because this folder's Claude Code project settings run scripts, and smurg cannot tell whether this command leaves them alone."
- **What this cannot see, and what to do about it.** smurg reads what a command names. A program that names none
  of the scripts (a build such as `npm run build`, a script of the project that rewrites another) is not seen
  before it runs. It asks like any other command unless someone always allowed its kind; smurg notices the changed
  script afterwards, stops the folder's agents and asks you again, but a hook that fires in between runs the
  changed script once, as you. And what a script runs in turn is not followed at all: anyone who can edit files in
  the folder can change what your confirmed commands end up running. So keep the scripts your hooks run in
  `.claude/hooks/`, where no teammate can write and no agent writes by itself, and name only files from there in a
  hook. Every existing file a hook command names counts as its script (`tsc -p tsconfig.json` records
  `tsconfig.json`), and the folder that holds it becomes a place where agents' file commands ask.
- You can look at the settings and change your decision at any time in the host console, under
  "Claude Code project settings"; a decision applies the next time a session's agent starts. `smurg status` shows
  the state for the shared folder (§7).

**`CLAUDE.md` is yours to edit.** Claude Code reads `CLAUDE.md` and `CLAUDE.local.md` as instructions, and agents
here run as you. Through smurg only you can change these files, at any depth of the folder; teammates see them
(not `CLAUDE.local.md`) and cannot change them, and no agent of a teammate's session can. A work item whose changes
touch such a file is not offered for merging from its report; you can still merge it yourself after reading the
diff (§10.3). The review of the project settings does not show these files: agents read them whenever the folder's
settings are in use or the folder has none. Read the `CLAUDE.md` of a repository that came from somewhere else
yourself before you share it.

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
  entry), for example the output of a command that printed a secret. The control is on people's messages, smurg's
  own messages, the agent's text and the lines of its tools. The entry is deleted from the disk, and everyone sees
  "The host removed this entry." in its place.
- **What removing an entry does not remove**: that people already saw it; Claude Code's own record of the
  conversation (below); and the copies smurg keeps outside the conversation. A question with its votes and
  comments, a permission request with the command or the diff it showed, and a suggestion are cards: the
  conversation only points to them, and they stay as they are. So do the excerpts in inbox items, the questions
  asked under a result report, and the audit log. Deleting the topic removes all of these except the audit log. A
  session without a topic has no such way: its conversation is removed 30 days after the session ended. The
  dialog that asks you to confirm the removal says which of the two applies to the entry.
- **Claude Code's own record**: Claude Code keeps its own transcript of each conversation under `~/.claude/` on its
  own schedule (30 days by default); smurg never reads or deletes it. It is the agent's memory. When an agent is
  continued after Claude Code removed it, the conversation says
  "Claude Code no longer keeps the earlier conversation. Claude starts again from the files."
- `smurg uninstall` removes the conversations with the rest of `~/.smurg` (§9.5).
- **The audit log** is in the same workspace folder (`audit.jsonl`, at most three files of 32 MB; the oldest
  entries go first) and keeps the full text of what was sent to agents. So that one member's loop cannot push
  everything else out of it, a member's accepted requests of one kind are recorded there up to 120 a minute. The
  rest of that minute are written whole to `audit-overflow.jsonl` beside the log, and the log gets one entry that
  says how many. The host console reads only the log: when you look into such a flood, open the overflow file
  yourself (one entry per line, in the same form). Never moved there: what you do yourself in the web app, what
  agents do, and every role change, removal of a member, decision about project settings and removed entry.

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

**What a stop does to sessions.** Terminal sessions end. Agent sessions are paused: their agents stop, what their
commands started and left running (a dev server, a watcher) is ended as well, their conversations are kept, and
smurg says how many there are, for example
`3 agent sessions are paused. They continue when you share this folder again.` When you share the folder again,
every conversation is readable and every agent is idle; a plan that had work running or waiting to start is paused.
Nothing runs by itself: a paused plan goes on when you or a member with agent access presses "Continue all"
(§10.5), and a discussion or a session without a topic goes on with its next message. A message that was still
waiting for its agent is kept and is delivered, in order, when that session next starts. An agent that was in the
middle of its work says so:
"smurg was restarted on the host's computer. The agent's turn was interrupted"

If `smurg host` ends without stopping properly (a crash, a kill, the computer losing power), the agents' own
processes may outlive it for a moment. They cannot do anything: every tool call of an agent is checked with smurg
first and is refused while smurg is gone. An agent can still receive some text from the model until its turn ends,
which is usage on your account. After the next start smurg ends what is left, and the conversation says
"smurg stopped while this agent was working. The agent may have gone on for a moment by itself: check its changes."

While sharing, `smurg host` tells you in the terminal when the connection to the relay is lost and when it is back,
when the relay refuses your login (it expired; teammates cannot connect), when your login is about to expire
(within 24 hours), when smurg's state file cannot be written, and once when the repository tracks smurg's own
`.smurg` folder (§10.2). When the login has expired or is about to, run
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
| `smurg host` does not start and names a file of the workspace's state (or the workspace itself). One of the next lines is "Nothing was changed." (after "What does not fit: …" for a file in an unknown form) or, when the system would not open or write a file, "smurg host did not start, and nothing in the workspace was changed or reset: …" | smurg read the workspace's state (`~/.smurg/workspaces/<workspace code>/`) and cannot use what it found: a newer smurg wrote it, a file is open to other users or belongs to someone else, a file is damaged or missing. §9.3 has every message and what to do for each. Do not move the folder away: that gives up the members, the invite links and the daemon key. |
| Above the two links: "An earlier state folder of this workspace lies beside the one in use" | You (or smurg 0.5.0's advice after an update) moved this workspace's state folder away earlier, and the workspace in use now is a new one. §9.4 says how to go back to the old one, and when not to. The line is printed once. |
| Above the two links: a warning that an older file "was put back into this workspace and upgraded again" | Someone put a copy that smurg had kept before an upgrade back in place of the file in use. Everything decided since that copy was made is undone (§9.2): go through the members, the roles and the invite links in the host console now. |
| Under the two links: "Warning: a teammate's page or smurg is newer than this smurg and was turned away. Stop sharing, run smurg update, then share again." | A teammate tried to connect with a newer web app (the relay was updated) or a newer `smurg` than yours, and the two do not speak the same protocol version. Until you update, nobody with the newer one can connect. Do what the line says (§9.1). It is printed once per run, and only for a teammate the workspace knows. |
| Under the two links: "A teammate's page or smurg is older than this smurg and was turned away. That teammate reloads the page or updates smurg; if you run your own relay, deploy it again." | A teammate still has a tab from before an update open, or an older `smurg` on their computer; or the relay you share through still serves an older web app. The teammate reloads the page or runs `smurg update`; your own relay needs a new deploy (§2.2). |
| Teammates see "The host's smurg is older than this page" | The relay serves a newer web app than your `smurg` can talk to. Stop sharing, run `smurg update`, share again (§9.1). |
| `smurg status` says "A smurg host of another version is sharing it", or `smurg host`, `smurg update`, `smurg uninstall` or `smurg attach` say that a smurg host of another version is sharing | The `smurg` command was replaced while a `smurg host` of the earlier version kept running (an install over a running share, for example), and the two cannot talk to each other. Stop the one that runs (`smurg stop` works across versions, or press Ctrl-C in its terminal), then start it again with `smurg host`. `smurg status` ends with exit code 5 in this case (0: a share is shown; 3: nothing is shared). A known limit: beside a `smurg host` of 0.4.0 that still runs, `smurg status` shows its usual lines and exit code 0, because 0.4.0's answer names no version; `smurg attach` does say that another version is sharing. |
| A teammate's page, or your own, says "Security warning: connection refused", or a link asks "The host computer's key has changed" | That browser or computer recorded another daemon key for this workspace than `smurg host` has now: you replaced the workspace's keys (§5.1 "After taking it back", step 1, or the last resort of §9.3), or you went back to a state folder you had moved away (§9.4 says who is affected). The warning's only way on is a link: open "Your link" yourself, send a teammate a new invite link, and tell them the daemon key fingerprint that `smurg status` shows over another channel (in person, on the phone), so they can compare it when the link asks about the changed key. If you did none of these, tell them not to continue: someone may be posing as you. |
| "The path of smurg's state folder is too long for a Unix socket" | Set `SMURG_HOME` to a shorter path (the path of a Unix socket has a length limit). |
| Teammates see "Host offline" | `smurg host` is not running, or the computer is asleep or has no network. |
| A topic or an agent session cannot be started: "Claude Code is not logged in on the host's computer, so no agent session can be started. The host must run `claude` and log in." (a session that is already open says "Claude Code is not logged in on the host's computer.") | Every agent uses your Claude Code login on this computer (§5.1). Run `claude` in your own terminal and log in; nobody can log in from inside a session. Then choose "Check login again" in the session, or send the next message. |
| "Anthropic rejected the host's Claude Code login. The host must log in again in their own terminal." | The login on this computer is no longer accepted. Run `claude` in your own terminal, log out and log in again. |
| An agent session cannot be started, and the sentence ends with "The host should update Claude Code." | Agent sessions need Claude Code 2.1.288 or later (§1); the sentence names the version it found. Update Claude Code (`claude update`, or the way you installed it). `smurg status` shows the version smurg sees. |
| "The claude command was not found on the host." / "Claude Code did not answer when the session started. The host should check that `claude` runs in a terminal on their computer." | Claude Code is not installed for your account, is not in the `PATH` that `smurg host` was started with, or does not start. Run `claude` in the terminal you start `smurg host` from. A session that failed has "Try again"; after three failed starts only you can try again. |
| "The host's Claude account has reached a usage limit." (your inbox: "The host's Claude account reached a usage limit") | The account `claude` is logged in to has no usage left for now. Every agent waits, and the web app says when the limit resets if Claude Code reports it. Whether the work then goes on by itself is up to Claude Code (smurg starts nothing again, and this was not tried with a real account): if an agent stays where it was, send it a message. Many agents working at once use a subscription's allowance quickly (§10.4). |
| A work item says "Stopped without a report" or "Stopped by a person, no report" | Its agent ended its turn without writing the result report, although smurg asked it once more ("smurg asked Claude for the result report"); or someone stopped it before it had written one. Open the session to see where it stands; "Continue" asks the agent to go on. |
| A work item says "Stopped on an error, no report", and its conversation says "smurg could not read this item's changes, so its report is not registered yet. It tries again when the agent's next turn ends." | The agent wrote its report, but smurg could not record the item's changes with it: someone kept typing in the worktree, there is a git repository inside it, or git took too long. No report appears until it can. "Continue" lets the agent go on; the report is registered when its next turn ends. A later version of a report that cannot be recorded leaves the earlier version in place and shows the same sentence. |
| An agent session cannot be started: "The path of this session's folder has a backslash or a control character in it. Claude Code's permission rules cannot name such a folder, so no agent session can be started there. The host should rename the folder." | Rename the shared folder, or the folder above it that has the character, and share again. Files and terminals work in such a folder; only agent sessions are refused. Spaces, parentheses, brackets and other signs in a path are fine. |
| A work item says "Failed" (your inbox: "the agent's process failed"), or its session shows "The agent's process ended unexpectedly" | Claude Code's process ended. "Try again" continues the same conversation. If it keeps failing, look at the daemon's log (§7). |
| A work item says "The plan changed: Start again" (your inbox: "did not start"): "The spec or the plan changed since Start. This item did not start." | A work item starts only from the spec and the plan that someone confirmed when they pressed Start (§10.2). Open the plan, look at what changed and press "Start again" on the item. Items waiting to start say the same when the folder stopped being a git repository for a while (§10.2). |
| Start is refused: "The shared folder is not a git repository, so worktrees cannot be used." | Run `git init` in the shared folder and commit once (next row, §10.2); no need to stop sharing. But if `.git` was there a moment ago, put it back; if a folder above is a repository, share that one. |
| Start is refused: "The shared folder's git repository has no commit yet, so no worktree can be created." | Commit the project's files as in §10.2: a worktree holds only what is committed. If git asks who you are, run `git config --global user.name 'Your Name'` and `git config --global user.email you@example.com`, then commit again. No need to stop sharing. |
| Start is refused: "The shared folder's .git is gone, so worktrees cannot be used." | The folder's `.git` was moved or deleted while there are worktrees or merge requests that still wait; Merge, the diff and a session that asks for a worktree are refused with the same sentence. Put that `.git` back: everything works again, without sharing again (§10.2). Do not run `git init` instead: a new repository cannot merge those requests. If that `.git` is lost for good, `git init` and a commit make Start work again, without those requests. |
| Start is refused: "git was not found on the host's computer, so worktrees cannot be used." | smurg uses the first `git` on the `PATH` of the terminal that ran `smurg host`. Install git 2.42 or later (macOS: `xcode-select --install`, or Homebrew), check in a new terminal that `git version` answers, stop sharing and run `smurg host` from that terminal. |
| Start is refused: "The host's git is version 2.39.5, and worktrees need 2.42.0 or later." | That is the first `git` on the `PATH` of the terminal that ran `smurg host`. Update git (macOS: the Command Line Tools in Software Update, or `brew install git`), check in a new terminal that `which git` and `git version` show the new one, stop sharing and run `smurg host` from that terminal. |
| Start is refused: "git does not run on the host's computer, so worktrees cannot be used." | On macOS, `/usr/bin/git` needs Apple's Command Line Tools; without them it brings up macOS's offer to install them, also when `smurg host` starts. Run `xcode-select --install` (on Linux, reinstall git). When `git version` answers in a terminal, stop sharing and run `smurg host` from that terminal. |
| Start is refused: "The shared folder's .git is not an ordinary folder (the folder is a git worktree or a submodule, for example), so worktrees cannot be used." | Worktrees are made only from a repository's main folder, where `.git` is a folder. Share that folder instead: it is another workspace, so send your teammates new invite links. Up to the plan, everything works in this one. |
| Start is refused: ".smurg/worktrees in the shared folder is not an ordinary folder, so worktrees cannot be used." | Something replaced the folder where smurg keeps worktrees. Move it out of the shared folder (look at it first), stop sharing and share again: smurg makes the folder anew. |
| Start is refused: "smurg could not look at the shared folder's git repository just now. Try again in a moment." | git failed or took too long this once. Press Start again; if it keeps happening, look at the daemon's log (§7). |
| Under the two links: "smurg's own .smurg folder is committed in this repository: run `git rm -r --cached .smurg` in the shared folder and commit." | A commit, a `git add -A` while sharing with smurg 0.5.1 or earlier for example, took smurg's share lock (`.smurg/daemon-lock.json`), which holds the path of your state folder. Do what the line says (§10.2): the files stay on disk, and `.smurg/.gitignore` keeps them out from then on. Until then git shows the lock as changed: `git rebase` refuses, and discarding changes (`git checkout -- .`, `git stash`, `git reset --hard`) puts back an old lock that lets a second smurg share the folder. Printed once per run. |
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
- **Your workspaces are kept.** The first `smurg host` of the new version reads what the earlier version wrote
  (members, invite links, keys, settings, topics, conversations) and carries it over; nothing is reset and nobody
  joins again (§9.2). What a version changes is in the changelog.
- **Your `smurg`, the web app and every teammate's `smurg attach` must speak the same protocol version.** The web
  app comes from the relay, and the shared relay gets each new version when it is published. While the page is newer
  than your `smurg`, teammates read "The host's smurg is older than this page" and cannot connect until you have
  updated; `smurg host` tells you in one line when it turned such a teammate away (§8). A teammate whose tab or
  `smurg` is the older one is told to reload or to update. When you run your own relay, deploy it again each time
  you update (§2.2).
- **Going back to an older version is not supported.** `smurg update` never installs one. A workspace that a newer
  smurg has shared may be refused by an older one: smurg 0.4.0 refuses every workspace that 0.5.0 or later has
  shared, and its message tells you to move the workspace's folder away. Do not follow that advice (§9.4 is for
  those who did): install the newest version again.
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

### 9.2 After an update: what your workspace keeps

`smurg update` replaces the executable and nothing else. A workspace's own state (the folder
`~/.smurg/workspaces/<workspace code>/`: the daemon key, the members, the invite links, the settings, the topics,
the conversations, the audit log) is looked at the next time you share its folder, and `smurg host` does that in two
steps:

1. It **reads** every file of the workspace's state and changes nothing. What an earlier published version wrote
   (0.4.0 and every version since) is brought to today's form in memory. When a single file cannot be used,
   `smurg host` does not start and the workspace is exactly as it was (§9.3).
2. Only when all of it could be read does it **write**: first a small file that names the smurg that shares the
   workspace (`written-by.json`), then, for each file it brought to today's form, a copy of the file as it was (see
   below) and the file in its new form. A start that is cut short here (the disk is full, the power goes) loses
   nothing: a file is replaced only after its copy is kept, and the next `smurg host` finishes the work.

When step 2 wrote a file in a new form, one line above the two links says so. It is printed at that start only:

```text
This workspace was last shared with smurg 0.4.0: its members, invite links and settings were carried over. What changed: https://smurg.ai/docs/hosting/#92-after-an-update-what-your-workspace-keeps
```

**Carried over from 0.4.0, as it was:**

- the workspace itself: the same workspace code and the same daemon key. The fingerprint is the one your teammates
  compared, and nobody is asked about a changed key;
- every member with their role, and every device: your teammates open the workspace again without a new invite link
  (in the browser once the page has loaded anew, with `smurg attach` once they have run `smurg update`). People you
  removed stay removed, and a revoked device stays revoked;
- the invite links: a link that had uses left still works, and a link that was used up, revoked or expired stays
  refused. As at every start, the host link of the last run stops working and a new one is printed;
- the settings you changed in the host console;
- kept worktrees with the work in them, the merge requests that wait for you, the kept copies of conflicts, an
  upload that was interrupted (it goes on where it stopped), the suggestions that were decided, the audit log and
  the activity feed;
- on this computer: your relay login, and the record of which folder is which workspace.

**New since 0.4.0, with these values after the update** (the host console's settings change them):

- "Agents may use my own and this project's MCP servers": off (§5.3). An update never switches this on;
- the waiting time after which a question or a permission request reaches the others: 5 minutes (§10.6);
- "Work items running at the same time": what a new workspace gets on this computer (§10.4).

**What did not come along, and why:**

- Sessions. Under 0.4.0 no session outlived `smurg stop`: its terminals had ended, and its agent sessions were
  terminals too, so there is no conversation to continue.
- A suggestion that still waited for an answer when sharing stopped: it is closed, as 0.4.0 itself closed them at
  every stop.
- Agent sessions with an older Claude Code: they need 2.1.288 or later now (§1).
- A teammate's `smurg` 0.4.0, and a browser tab from before the update: both are turned away until the teammate has
  updated or reloaded (the guide for teammates, §8 and §10).

**Roles and invite links from 0.4.0 mean more now.** The roles kept their names, and every member and every unused
invite link kept its role. But 0.5.0 gave the roles more to do, and nobody decided that again for your workspace:

- **Editor** now also takes part in topics: an Editor votes on agents' questions, comments on them and reviews
  result reports.
- **Agent access** now also creates topics and starts their work items, sends messages to agents, answers what
  agents ask to run on your computer, and changes who is responsible for a session.
- **Viewer** reads, as before.

An unused link made under 0.4.0 gives whoever opens it today's meaning of its role. Go through the members and the
invite links in the host console once after the update, and change a role or revoke a link you would not give today
(§5.1 says what Agent access means).

**The copies smurg keeps.** Before it writes a file in a new form, smurg keeps the file as it was beside it, named
after the version it came from: `state.json.before-upgrade-from-0.4.0`,
`suggestions.json.before-upgrade-from-0.4.0`. A copy is never written again, only you can read it (mode 600; a start
checks that as it does for the state file), and smurg never reads it. If a file of the older form that is not the copy is ever upgraded again (you went back to the
older smurg, worked there and updated once more), smurg keeps that file too, under the same name with `-2` at its
end (then `-3`, and so on). It is there so that you can look up what the workspace held. It holds the keys
of your invite links: keep it as private as the state file itself, and delete it when you no longer need it.

**Do not put a copy back in the place of the file in use.** `state.json` is where smurg records who was removed,
which device was revoked, which invite link was used up or revoked, and who has which role. Putting the copy back
undoes all of that since the update: people removed since are members again, revoked devices and revoked or used-up
invite links work again, and role changes are gone; whoever joined since is no longer a member, and invite links
made since no longer work. smurg cannot prevent it. It says so at the next start, with a
warning that an older file "was put back into this workspace and upgraded again" in the place of the line above; go
through the members, the roles and the invite links in the host console then.

### 9.3 When `smurg host` refuses a workspace's state

`smurg host` uses a workspace's state only when it can read all of it. Otherwise it does not start, and it changes
nothing: the members, the invite links, the keys and the settings are as they were, and you can try again as often
as you need. The lines after `smurg:` name the file (or the workspace's folder), say why, and say what to do; the
daemon's own line about it is in the log (`~/.smurg/logs/`). A refusal that comes later, while the start was
already writing (the disk filled up), does not say "Nothing was changed." but that nothing in the workspace was
changed or reset: what the start had begun stays, and the next start finishes it (§9.2). Never move the workspace's
folder away to get past a refusal: that gives up the members, the invite links and the daemon key. The terminal
names it only as the last resort, after what it costs, and not at all for a file that can be set aside alone (below
the table).

| The terminal says | What happened, and what to do |
|---|---|
| "This workspace was last shared with a newer smurg than this one (this is 0.5.1), and this smurg cannot read what it wrote" (it names the newer version when the workspace records it) | A newer smurg has shared this workspace. Run `smurg update`, then `smurg host` again. When `smurg update` answers that you have the newest version, the folder was written by a smurg this computer cannot get that way (a build that was never published, or a folder copied from another computer): share the folder with the smurg that wrote it. The terminal names the file that records the writer, `written-by.json`. |
| "A file of this workspace's state is open to other users of this computer (mode 644)" | The file's permissions let other accounts of this computer read or change it, and smurg does not use such a file. Run the one `chmod 600 …` line the terminal prints (it names every such file), then `smurg host` again. Until now those accounts could read the file, and a workspace's state holds the daemon key and the keys of its invite links: if you do not trust them, replace the keys (§5.1 "After taking it back", step 1). |
| "A file of this workspace's state belongs to another user, not to you" | Usually smurg was once run with `sudo`. `chmod` does not change who owns a file: the owner or an administrator of this computer gives it back to you (`chown`). Then run `smurg host` again. |
| "A file of this workspace's state is a symbolic link, and smurg follows no link in its state folder", or "Where a file of this workspace's state belongs there is a folder" | smurg reads only a regular file of your own in that place. Put the file itself there (mode 600), then run `smurg host` again. |
| "A file of this workspace's state could not be opened or written (permission denied, EACCES)" (or another reason of the system's) | The system would not open the file or write it: a permission, a full disk, a disk that fails. smurg never starts a new workspace in such a case. Put right what the reason names, then run `smurg host` again. When the file it names is not there (`written-by.json` at the first start of this version), smurg was not allowed to create it: look at the permissions of the workspace's folder itself. |
| The state file in the folder of the workspace "names another workspace" | The folder was copied from another workspace's, or the two were mixed up. No command repairs this: put this workspace's own folder back in its place. |
| "The state file of this workspace is not there, although other files of the workspace are", or "The daemon's key of this workspace is not there, although its state file is" | A file was moved, renamed or deleted by hand. smurg makes no new one in its place (a new state file would forget who was removed, a new key would make every teammate's browser warn). Put the file back. If it is gone for good, the terminal goes on as for a damaged file (below the table): for the state file the newest kept copy, when there is one, then the last resort; for the key the last resort only. |
| "A file of this workspace's state is damaged: it is not valid JSON (it may be empty or cut off)", or "A file of this workspace's state is not in a form that smurg 0.5.1 or an earlier published smurg wrote" | The file was cut off, or changed by hand or by another program, or written by a smurg that was never published. "What does not fit:" lists the places in the file and the rule each one breaks (never a value from the file; the rules are worded in English in every language). The terminal then goes through what you can do, in this order (below the table). |
| "A state file that an earlier smurg wrote holds a value that smurg 0.5.1 does not accept" | The one known case: a path or a name with more than 30 combining marks in a row, which 0.4.0 accepted and later versions refuse everywhere. "What does not fit:" names the entry (counted from 0) and ends in `mark-run`. It can sit in `conflicts.json` (the file of a kept conflict), in `worktrees.json` (a worktree's shared folder, a file of a merge request) or in `state.json` (`settings.sharedDirs`: "Shared folders (read-only in worktrees)" in the host console). Nothing is dropped for you. For the first two the terminal offers to set that one file aside (below the table); for `state.json` it names only the last resort. What keeps the workspace there: take the named entry out of the file by hand (keep a copy, leave the mode at 600). `smurg host` then starts and carries the rest over. |
| "The workspace list (workspaces.json) was written by a newer smurg than this one (this is 0.5.1)" (or the relay login, `credentials.json`), or one of the two "is not in the expected format" | These two files in `~/.smurg` are this computer's own: which folder is which workspace, and your relay login. smurg no longer reads such a file as empty and writes over it. Written by a newer smurg: run `smurg update`. Not in the expected format: repair the workspace list or put a copy of it back (without it, `smurg host` gives a folder a new workspace); a login you can move away and replace with `smurg login`. |
| "This folder's entry in the workspace list (workspaces.json) is not in a form this smurg can read (this is 0.5.1)" | The list can be read, the entry of the folder you share cannot; the terminal names the entry and what it cannot read in it. `smurg host` stops, because without that entry it would give the folder a new workspace. If a newer smurg was ever used on this computer, run `smurg update`; otherwise repair the entry (its form is below the table) or put a copy of the file back. An entry smurg cannot read is never dropped: a note above says how many the file holds. |

For a file that is damaged or in an unknown form, the terminal lists, after "Nothing was changed.":

1. "First: if a newer smurg was ever used on this computer, run smurg update, then smurg host again." Shown when
   nothing records which smurg wrote the folder: a newer smurg's file looks like damage to an older one.
2. The newest copy smurg kept of that file before an upgrade (§9.2), by name and date, after what putting it back
   undoes. For `state.json` that is everything decided since the copy was made. Take it only when what the workspace
   held then is what you want, and go through the members, the roles and the links afterwards.
3. For a file of the table below: "This one file can be set aside without losing the workspace: …", what the file
   holds, and the command that moves that one file to `<file>.set-aside-<date>-<time>` beside it. The members, the
   invite links, the settings and the daemon key stay, and smurg makes a new, empty file at the next start. The
   last resort is then not printed.
4. For every other file: "The last resort is a new workspace." The terminal says what that costs before it names
   the command: the workspace's members and invite links, its topics, conversations and audit log, and the daemon
   key (your teammates join again with a new link and are asked about a changed key); and smurg no longer knows the
   worktrees it kept. The command it prints moves the folder to a name that carries the date and the time, so the
   folder is kept and the way back of §9.4 stays open.

| File | What it holds | Setting it aside loses this, and nothing else |
|---|---|---|
| `inbox.json` | what each member has read or dismissed in their inbox, and the mentions kept for them | everything in every inbox is unread again; the kept mentions |
| `suggestions.json` | the suggestions members made to agent sessions | all of them; one that still waited is made again |
| `conflicts.json` | the list of kept conflicts between a person's and an agent's edit of the same file | that list: the agent's version can no longer be applied from smurg. Your files are not touched |
| `worktrees.json` | smurg's record of the worktrees it made and of every merge request | smurg no longer knows any worktree (the folders stay in `.smurg/worktrees/` with the work in them: merge it by hand), and a request that waited is gone |
| `sessions.json` | which terminal sessions were running | nothing after a normal stop; after a crash, processes those terminals left running are not ended for you |
| `host-rules.json` | your own Claude Code allow rules as smurg last saw them | nothing that lasts: smurg tells you about the rules again |
| `claude-trust.json` | your decisions about projects' Claude Code settings | all of them: agent sessions start without a project's settings until you confirm them again |
| `cards.json` | which conversations have questions and permission requests | the ones asked so far are no longer shown |

Where a conversation showed a question, a permission request or a suggestion that is gone this way, the page says
"The host's computer no longer keeps this card." Five files cannot be set aside, and the last resort stays the only
way: `state.json` and `identity.key` are the workspace itself, and the rest of the state points into
`agent-sessions.json`, `topics.json` and `reports.json` (without one of them, topics would name sessions and reports
that are not there). A log the system cannot read (`audit.jsonl`, `audit-text.jsonl`, `activity.jsonl`) can be moved
away too: what that file recorded is lost, and a new one starts.

An entry of `shared` in `~/.smurg/workspaces.json` (`workspaceId` is the name of the workspace's folder in
`~/.smurg/workspaces/`, `createdAt` a whole number):

```text
{ "folder": "/Users/you/projects/my-app", "relay": "https://app.smurg.ai", "workspaceId": "ws_YOURCODE", "createdAt": 1791377829732 }
```

### 9.4 If you moved the state folder away because smurg 0.5.0 told you to

smurg 0.5.0 could not read a workspace that 0.4.0 had shared. It refused to start and told you to move the
workspace's folder away (`mv … ….old`) and to share again. If you did, you have had a new workspace since then: the
same workspace code, a new daemon key and only yourself as a member. Your teammates were asked about a changed key,
and the invite links of before stopped working.

The folder you moved is still there, `~/.smurg/workspaces/<workspace code>.old`, with the members, the invite links
and the old daemon key in it, and smurg 0.5.1 and later can read it. At its first start such a version names the
folder, once, above the links: "An earlier state folder of this workspace lies beside the one in use". To go back:

```sh
smurg stop                                     # 1. stop sharing
cd ~/.smurg/workspaces                         #    (or the workspaces folder of your SMURG_HOME)
mv ws_YOURCODE ws_YOURCODE.new-workspace       # 2. set the workspace in use aside
mv ws_YOURCODE.old ws_YOURCODE                 # 3. put the earlier one back under its own name
smurg host ~/projects/my-app                   # 4. share the folder again
```

`ws_YOURCODE` stands for the workspace code: the name of the folder that is there twice, once with `.old`. At step
4 `smurg host` reads the earlier state, brings it to today's form and prints the line of §9.2. The two links carry
the earlier daemon key again, and whoever was a member before the folder was moved is a member again, with the
devices they had. That includes people you had not invited again in between, with the role they had before: go
through the members, the roles and the invite links in the host console after step 4 (§9.2). This was tried, step
by step, with a workspace that 0.4.0 had really written.

What going back means for what happened in between:

- Whoever opened the new workspace in between has ITS key recorded: your own browser, and every teammate who
  joined it or accepted its key. They are not asked anything. Their page says
  "Security warning: connection refused" (`smurg attach`:
  "… the key of the host's computer differs from the one this computer recorded last time …"), and its only way on
  is a link. Open "Your link" of step 4 yourself. Send the others a link again, and tell them over another channel
  the fingerprint that `smurg status` shows now (the one from before the move). With the link they are asked
  "The host computer's key has changed", compare the fingerprint and confirm.
- The link for teammates that step 4 prints is an Editor link (unless you chose another with `--role`). An earlier
  member with another role (Viewer, Agent access) who takes it reads "This invite link cannot be used" after
  confirming the key. The key was accepted all the same: they open the workspace again, without the link, and are
  in. Or make them a link of their own role in the host console.
- Someone who joined only the new workspace is not a member of the earlier one, and the invite links made in
  between do not work in it: send a new link.
- The topics, the conversations and the audit log of the time in between are not merged into the earlier
  workspace. They stay in the folder you set aside at step 2; the spec, plan and report files of those topics are
  files of your project and stay where they are.
- The worktrees of that time (`.smurg/worktrees/` in the shared folder) stay on disk, and smurg no longer knows
  them: merge by hand what you still need, then delete them.
- What 0.4.0 left open is open again: the kept worktrees with their work, and the merge requests that waited for
  you, which can still be read and approved.

Two more things to know:

- If you moved the folder twice, the second `mv` did not replace the first `.old` folder: it put the folder it
  moved inside it, as `<workspace code>.old/<workspace code>/`. The earlier state is what lies directly in the
  `.old` folder; move the folder inside it out before step 3.
- If you moved the folder on purpose, to replace the workspace's keys (§5.1 "After taking it back", step 1), do
  not go back: the keys you wanted to replace are in it. Leave it where it is, and delete it when you no longer
  need its conversations and its audit log.

### 9.5 Remove: `smurg uninstall`

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
- **Confirm the folder's Claude Code project settings** (§5.3), edit `CLAUDE.md` and the scripts those settings
  run, and rename or delete a folder that holds a file only you may change (§4).
- **Allow the requests that reach beyond the project**, and a command that writes where one of those scripts is
  (§5.2, §5.3).
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
  repository with at least one commit, and git must be 2.42 or later. Without that, everything up to the plan
  works, and Start says what is missing and what to do (§8); a session that asks for a worktree of its own is
  refused with the same words.
- **The folder can become a repository while you share it.** In your own terminal, in the shared folder:

```sh
git init
git add -A                      # write a .gitignore for node_modules and the like first
git commit -m "First commit"
```

- smurg looks again whenever Start is pressed, and every few seconds: the next Start sees the repository, without
  sharing again, and open pages see it within seconds (in a workspace without a topic, a page sees it after a
  reload, or when it asks for a session in a worktree; the plan column knows only whether the folder is a
  repository: a missing first commit or a problem with git, Start says). A change of git itself (installed,
  updated, repaired) needs sharing again: smurg looks for git, on the `PATH` of the terminal that ran `smurg host`,
  only when sharing starts or the folder becomes a repository (§8).
- **git leaves smurg's own `.smurg` folder out.** Each start of sharing writes `.smurg/.gitignore` (`*`) unless there
  is one, so git leaves the folder out whatever the order of `git init`, `git add -A` and `git commit`. If the
  repository already tracks it (committed while sharing with smurg 0.5.1 or earlier), `smurg host` says so once;
  take it out:

```sh
git rm -r --cached .smurg       # the files stay on disk
git commit -m "Stop tracking smurg's own folder"
```

- If `.git` goes away while you share, Start is refused with the reason, and items waiting to start may need
  "Start again" (§8). Nothing is deleted: worktrees, their work and merge requests work again once that `.git` is
  back. Put it back rather than run `git init`: a new repository cannot merge those requests.
- **Start shows what it will do before it does it**: which items start now and which wait for others, who is
  responsible for each, who edited the spec and the plan by hand since the last Start, and the commit below. Read
  it: it is the moment the team's text becomes instructions for agents that run as you. A member who renamed or
  deleted the topic's folder, or `specs` itself, is named there for both files. A change of `SPEC.md` or `PLAN.md`
  that a program outside smurg made is listed as such; a whole folder that such a program swapped is not listed,
  though smurg reads the two files again at once and Start confirms what they hold then.
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
- The row in your inbox opens the item's result report. "Merge…" there shows the complete diff; you read it, then
  choose "Merge into the main workspace" or "Reject". (A request that someone made after the report, or for a
  worktree without a report, opens the list of its changes instead, with the same two choices.) The merge commit
  is yours and says whose work it was (`Merge smurg/<topic folder>/<item id> (<name>)`: the member who asked for
  the merge, else the one who started the item).
- **Work items that depend on others start only after you merged those.** In a plan with dependencies, you are the
  one everybody waits for: the plan says which items wait for a merge, and the inbox puts the merges that unblock
  something first.
- Changes that smurg will not offer from a report: ones that contain files only you may change (`CLAUDE.md`,
  `.claude/`, `.envrc` and the like, and the scripts your confirmed project settings run, §5.3), that touch the
  topic's own `SPEC.md` or `PLAN.md`, or that contain a link pointing out of the project. The report says why, for
  example
  "The changes cannot be shown: the worktree contains files only the host may change."
  You can still request the merge yourself in the web app and read the diff before you decide.
- **A conflict** stops the merge and leaves the main workspace as it was. You or a member with agent access can
  then ask the item's agent to resolve it: smurg itself merges the main workspace into the item's worktree (no agent
  runs git, and none of your git hooks or git settings is used), the agent resolves the marked places and writes a
  new version of the report, and the merge is offered again. Files of the worktree that git does not track are
  never overwritten by this.
- Everyone can read the diff of a report. A file that teammates cannot see (§4) is listed there without its content
  for everyone but you, and text that looks like a credential is shown as `[masked]` to everyone.
- A work item that is merged and reviewed is finished once nothing unmerged is left in its worktree: its session
  ends, its worktree is removed, its conversation and its report stay readable. Two cases keep it open. A
  follow-up after your merge made the agent change something more: the new change waits for your merge like the
  first one ("Reviewed · waits for the host to merge"), and the item is finished when you have merged it. Or the
  worktree holds changes that no merge carried (edits made after the last report, for example): the item keeps its
  session and its worktree until those changes are merged too or you remove the worktree. Archiving a topic lists the work
  items whose changes were never merged and asks whether to keep or delete them.

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
  per topic. Whoever looks after a work item that was interrupted has one more for that item, with "Continue" for
  it alone;
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
  ("Amy left. This session now runs for the host"). When they left or are now a Viewer, whatever they were
  responsible for is decided by the next person in line: whoever opened the session or pressed Start, or you. A
  member you made an Editor stays responsible for what they had. The worktrees of the sessions that ended are
  kept, with their changes. After a role change they pass to you. A member who left keeps theirs: leaving does not
  take away the role, and they find them when they open the workspace again.
- **You remove a member**: the same, but their topic sessions are stopped first
  ("Amy was removed. This session was stopped and now runs for the host"), and the worktrees they had kept pass
  to you. A member who is removed and joins again does not get their old sessions back.
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
merge) was verified by smurg's developers against a scripted stand-in for the model. Real Claude Code (version
2.1.288, the oldest that agent sessions accept) was run with smurg only against a fake API on the development
machine, never against the real model. No real Claude account was used for testing. That machine is a Mac:
real Claude Code was not run with smurg on Linux at all for this version; on Linux only the stand-in was tested.
So how a real model behaves in this flow is not verified yet: whether it asks its questions as cards as it is
told, writes the plan and the report in the format smurg checks, and proposes a sensible split of the work. This
may need tuning in later versions.

What bounds the damage when an agent does not behave: smurg checks the plan and the report format itself and asks
the agent to fix them (at most twice in a row), asks once for a missing report, and puts work that stopped into
someone's inbox instead of letting it stop unseen. Watch your first topic with a real project closely, and if a
step of the flow does not work with your Claude Code, report it at https://github.com/gclinian/smurg.

Limits of this version that are known:

- Agents start no subagents, and agent definitions in `.claude/agents` are not used (§5.2).
- In a folder whose project settings run scripts, smurg reads what an agent's shell command names. A program that
  names none of the scripts (a build, a script that rewrites another) is not seen before it runs (§5.3).
- Removing an entry of a conversation does not remove the cards, the inbox excerpts and the audit entries that
  hold the same text (§5.4).
- A link in what an agent or a member wrote shows where it leads only when you rest the pointer on it or reach it
  with the keyboard. smurg writes the destination out beside the words when the words themselves name another
  place (`github.com (https://evil.example/)`), but it does not recognize every such case: a name under a less
  common ending (`amazon.in`, `github.lol`) and a name with a sign in it that only looks like a dot are drawn as
  ordinary links. Look at the destination before you follow a link (the guide for teammates, §5).
- A spec or a message that takes too long to format is shown as it was written, in whole or in part, under a
  note. In a very large spec of that kind the first keystrokes can each take most of a second, until every
  section that is slow to format has been set aside.
- When an agent session ends, or you stop sharing, smurg ends what the agent's commands left running. On macOS it
  can miss one kind of program: a background job of one of Apple's own programs (`/bin/sleep`, `/usr/bin/python3`)
  whose shell ended at once. smurg finds such a job only if its scan, every two seconds, saw it while the shell
  still ran. A `node`, a `pnpm` or a `python` from Homebrew is found.
