# Host guide: share a folder with smurg

This guide is for the **host**: the person who runs `smurg host` on their own computer to share a project folder with
teammates. Teammates should read the [guide for teammates](JOINING.md). This guide in [繁體中文](zh-TW/HOSTING.md).

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
- To run Claude Code in sessions, this computer also needs the `claude` command (2.1.220 or later), **already logged
  in** to your Claude account: every agent session uses this computer's login, including sessions opened by teammates
  with agent access (§5.1).
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

- It cannot see: file contents, file names, terminal output, the commands you or your teammates type, the secret in
  an invite link, or any key. These are end-to-end encrypted between your computer and each teammate's browser (or
  CLI); the relay only forwards the encrypted data.
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
  most expensive thing is **several people watching a terminal or an agent that prints a lot**; an open workspace
  with occasional edits uses very little.
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
The invite links you print point at the relay you use, so teammates need no setup.

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

The terminal does not repeat this guide: **read §4 before you share for the first time**; Agent access and the notices of
agents' shell commands are in §5. For details while sharing, use `smurg status` (§7): the daemon
key fingerprint, whether the notices of agents' shell commands are on, keep-awake, and where the log is. The terminal speaks
up only when you need to act: **the computer cannot be kept awake** (§6), the connection to the relay is lost, the
relay refuses your login, or the state file cannot be written (§7); when a new version exists, one more line
appears under the links (§9.1).

**Daemon key fingerprint**: the first time a teammate joins, they can check this fingerprint with you over another
channel (in person, on the phone) to make sure nobody, the relay included, is posing as you. `smurg status` shows it
(the "Daemon key fingerprint" line).

Roles: Viewer (`viewer`) can only look; Editor (`editor`) can edit files and send suggestions to agents; Agent access
(`agent`) can also open agents and terminals on your computer **as you** and type into any session (§5.1). Later you
can manage members, roles, invites and sessions, and read the audit log, in the host console of the web app.

## 4. Before you share

`smurg host` does not print these reminders in the terminal: read them before you share for the first time.

- **Every member can see the files in the folder** (viewers too), for example `.env` and configuration files. The
  only things teammates cannot see or download in the web app and the CLI are: smurg's own `.smurg/`, every `.git`
  folder, `.envrc`, and your personal Claude Code settings (`.claude/settings.local.json`, `CLAUDE.local.md`). This
  limits what people see: every agent and terminal session runs as you, so it can read those files, and the other
  files on your computer too (§5.1). Do not share a folder that holds passwords, keys or personal data; you also
  cannot share your whole home folder or a folder that contains it.
- **No agent session is sandboxed**: the ones you open and the ones teammates with agent access open all run under
  your operating-system account, and they read files that teammates wrote or changed. A file can hide instructions
  meant for the agent (prompt injection). Keep Claude Code's permission prompts on, do not auto-approve, and watch
  files that teammates changed recently. Teammates with agent access can also answer those prompts for you in a
  session.
- **Give Agent access only to people you fully trust** (§5.1): this role lets someone make an agent run any command
  on your computer, read your home folder and use your Claude account. Other teammates can edit with you and send
  suggestions to agents as Editors.
- Teammates can use the workspace only while `smurg host` is running and your computer is online.
- Editors and above can create or change files such as `.gitmodules`, `.gitconfig`, `.bashrc`, `.zshrc` and
  `.profile` in the shared folder (git and the shell do not run them from a project folder). Look at `.gitmodules`
  before you run `git submodule update`.

## 5. Agent access and agents' shell commands

### 5.1 The Agent access role (read this first)

Agent access (`agent`) is the highest role you can give a teammate. A teammate with this role can:

- open **agent (Claude Code) and terminal sessions** on your computer, in the main workspace or in a worktree;
- type into **any** session, including the ones you opened and the ones other teammates opened;
- accept or reject the suggestions any session receives, and ask you to merge any worktree (only you decide a merge).

These sessions **run on your computer as you**, exactly like the ones you start in your own terminal:

- **No sandbox**: your operating-system account, your home folder (including your settings, `CLAUDE.md` and memory
  in `~/.claude`) and your environment variables.
- **Your own Claude Code login**: every agent uses the account `claude` is logged in to on this computer (your
  subscription or your API key), and **the usage and the cost are yours**. Teammates do not need, and cannot use,
  their own Claude account or API key.
- A worktree is only a place to work, not protection: a session opened in a worktree runs as you all the same.

**The risk**: giving someone Agent access means letting them use your account on your computer. They can:

- make an agent or a terminal **run any command on your computer**: install or delete programs, change or delete
  files outside the shared folder, connect anywhere on the network;
- **read your home folder**: the keys in `~/.ssh`, other projects, the credentials of other programs and cloud
  services, and the `.git` and `.envrc` in the shared folder that teammates otherwise cannot see;
- **use your Claude account**: spend your subscription's quota, or run up cost on your API key.

smurg cannot limit any of this. Everyone in the workspace sees every session live, and the audit log records who
opened each session, but that only tells you afterwards what happened. **Give this role only to people you fully
trust**, for example someone you would hand your logged-in computer to. Make everyone else an Editor: they can edit
files with you and send suggestions to agents, and you or someone with agent access decides whether to accept them.

- **Giving it**: share with `smurg host <folder> --role agent`, and the teammates' link it prints is an Agent access
  link; or, while sharing, create an invite link with this role or change a member's role to Agent access in the host
  console of the web app (the console shows the same warning first, and creates or changes nothing until you confirm
  that you understand).
- **Taking it back**: in the host console, change the role back to Editor or Viewer, or remove the member; the
  sessions they opened end at once, and they can no longer open sessions or type into them. **This only takes back
  what they may do in smurg.** What they already did as you does not go away: see the "After taking it back" list
  below.
- Before you start, make sure `claude` is logged in on this computer (run `claude` in your own terminal and type
  `/login` if needed). If it is not, the agents teammates open show that it is not logged in: log in yourself, and
  do not let a teammate `/login` with their own account in a session (that would store their credentials on your
  computer, and every agent would use them from then on).

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
   - Claude Code's settings: the `hooks` in `~/.claude/settings.json`, and `~/.claude/CLAUDE.md` (every later agent
     follows it);
   - your git projects (the shared one and the others): the scripts in `.git/hooks/`, and git settings that run
     programs, for example
     `git config --show-origin --get-regexp 'core\.(fsmonitor|hooksPath|sshCommand)'` (look at `~/.gitconfig` too);
   - programs that are still running: when a session ends, smurg ends the programs it can find, but a program that
     deliberately detached from its session may keep running under your account, and it can type into any session,
     yours included, through the control socket on this computer (the one `smurg attach` uses). If you are not sure,
     restart the computer after the checks above.
5. **Logs cannot tell them from you**: what they did through a session under your operating-system account looks, in
   the logs of the system and of other programs, exactly like what you did yourself; smurg's audit log records who
   opened a session and who did what in the web app, but not the commands and output inside a session. The control
   socket on this computer (the one `smurg attach` uses) can only list sessions, attach to them and type into them;
   it cannot change roles, approve merges, remove members or change settings in your name. But until you took the
   role back, they could do anything your operating-system account can do.

### 5.2 Notices of agents' shell commands

On by default; turn it off with `--no-bash-attribution`. The setting is fixed when sharing starts: to change it, stop
sharing and run `smurg host` with the new option (the workspace and its members for that folder are kept, and
teammates do not have to join again). `smurg status` shows whether it is on while you share (§7).

When an agent changes a file with tools such as Edit or Write, smurg knows which agent did it. When an agent changes
files with a shell command (`sed -i`, a formatter), smurg could only show the change in the activity feed as
"Outside program". Now:

- Each agent session tells the smurg on this computer when a shell command starts and when it ends. **Neither the
  command nor its output is included**, and no command is ever blocked: when smurg does not answer, the command runs
  as usual and is simply not recorded under that agent.
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
smurg stop            # stop sharing: drops every connection and ends every session
```

`smurg status` lists every workspace being shared (everything `smurg host` does not print at start is here):

- the workspace code, the shared folder, the relay's address (it says when that is the shared relay) and the
  connection state, the number of connections and the members online;
- the **daemon key fingerprint** (§3);
- keep-awake (§6);
- notices of agents' shell commands (on or off, §5.2);
- where the daemon's log is: `~/.smurg/logs/<workspace code>.log` (mode 0600, no invite links in it). When
  something goes wrong, the details are there.

Pressing Ctrl-C in the terminal of `smurg host` does the same (stopping takes a few seconds; pressing again within 2
seconds does not interrupt it, and pressing once more after that ends it at once, possibly before everything has
stopped).

While sharing, `smurg host` tells you in the terminal when the connection to the relay is lost and when it is back,
when the relay refuses your login (it expired; teammates cannot connect), when your login is about to expire
(within 24 hours), and when smurg's state file cannot be written. When the login has expired or is about to, run
`smurg login` in **another terminal** (with the same account; if the relay you share through is not the one you last
logged in to, add `--relay <its address>`): `smurg host` switches to the new login within seconds, and you do not
have to share again.

To attach to an agent session in your own terminal: `smurg attach` (lists them), `smurg attach <number>`; Ctrl-]
detaches.

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
| "This workspace's state files were written by another smurg version, or are not in the expected format; the daemon refused to start" | The workspace state for this folder (`~/.smurg/workspaces/<workspace code>/`) cannot be read: usually another version of smurg wrote it (smurg does not convert other versions' state); another program may also have changed it, or its permissions are wrong. Which file and why is in the log file the terminal names. What to do: move that folder somewhere else (for example, add `.old` to its name) and run `smurg host` again. That creates a new workspace state: the earlier members and invite links stop working, and teammates join again with a new invite link. The daemon key is new too: teammates who joined before see "The host computer's key has changed", so tell them the new key fingerprint from `smurg status` over another channel (§5.1 "After taking it back", step 1, which also covers the old worktrees). |
| A teammate says they see "The host computer's key has changed" | You replaced the workspace's keys (§5.1 "After taking it back", step 1, or the row above): look up the new daemon key fingerprint with `smurg status` and tell them over another channel (in person, on the phone), so they can compare it before they continue. If you did not replace anything, tell them not to continue: someone may be posing as you. |
| "The path of smurg's state folder is too long for a Unix socket" | Set `SMURG_HOME` to a shorter path (the path of a Unix socket has a length limit). |
| Teammates see "Host offline" | `smurg host` is not running, or the computer is asleep or has no network. |
| "Your Claude Code is not logged in." (teammates see "The host's Claude Code is not logged in, so this agent cannot work for now.") | Every agent uses your Claude Code login on this computer (§5.1). Click that agent's terminal, type `/login` and follow the screen (or run `claude` in your own terminal and log in), then go back to the session and type the next instruction. |
| A teammate cannot open a session ("New session" says their role cannot open sessions) | Only Agent access can open sessions (§5.1). To give it, change their role in the host console; read the risk in §5.1 first. |
| Files an agent changed with a shell command show as "Outside program" in the activity feed | You started sharing with `--no-bash-attribution`, or two or more agents were running shell commands at the same time, so smurg cannot tell which one it was (§5.2). |

All state (keys, logins, workspaces, log files) is in `~/.smurg` (`SMURG_HOME` changes the place); the log files
are in `~/.smurg/logs/` and contain no invite links.

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
Version 0.4.1 is available (this is 0.4.0): stop sharing, then run smurg update
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
  invite links, log files. Afterwards the members and invite links of the workspaces you shared no longer work.
  `--keep-data` keeps it.

It does not touch:

- **the `.smurg/` folder inside a project folder**: the worktrees and the changes not merged yet are in there.
  `smurg uninstall` only lists the ones it knows about; whether to delete them is up to you.
- shell startup files: the installer only told you to add `~/.local/bin` to your `PATH`; it never changed your
  files. Remove the line you added yourself.

Before it does anything, it lists every path it will remove with its size and asks "Remove these? [y/N]"; it
removes them only when you type `y`. `--yes` does not ask; outside a terminal `--yes` is required, otherwise it only
prints the list and ends. A workspace that is being shared is stopped first (as `smurg stop` does); if it cannot be
stopped, nothing is removed. When `SMURG_HOME` points somewhere that must not be deleted (`/`, your home folder, or a
folder holding things smurg did not create), it refuses: use `--keep-data` then, and deal with that folder yourself.

When you run smurg from source: delete the three places above yourself.
