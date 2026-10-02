# Guide for teammates: join a shared workspace

This guide is for **teammates**: someone shared a project folder with smurg and sent you an invite link. You do not
need to have used smurg or Claude Code before. The host (the person who shares the folder) should read the
[host guide](HOSTING.md). This guide in [繁體中文](zh-TW/JOINING.md).

Three things to know first:

- **Every file is on the host's computer.** What you see and change in the browser is the file on the host's
  computer; saving is automatic.
- **Claude Code** is an AI coding assistant that works in a terminal (called an **agent** below): you tell it what to
  do in plain sentences, and it reads files, changes code and runs commands. In smurg every agent runs on the host's
  computer, as the host, and everyone in the workspace sees what it is doing, live.
- The connection between you and the host's computer is **end-to-end encrypted**: the server in between (the relay)
  cannot see file contents, terminal output or commands (it knows which account you logged in with and the IP address
  you connect from).

Contents: [1. Join](#1-join-with-an-invite-link) · [2. Roles](#2-roles-what-you-can-do) ·
[3. Edit together](#3-edit-files-together) · [4. Lock notices](#4-what-the-lock-notices-mean) ·
[5. Watch agents and send suggestions](#5-watch-agents-and-send-suggestions) ·
[6. Open agent sessions (Agent access)](#6-open-agent-sessions-agent-access) ·
[7. Worktrees and merge requests](#7-worktrees-and-merge-requests) · [8. Host offline](#8-what-host-offline-means) ·
[9. Leaving](#9-leaving-a-workspace-what-ends) · [10. From a terminal (CLI)](#10-joining-from-a-terminal-cli-optional)

## 1. Join with an invite link

An invite link looks like this: `https://<site>/join/<workspace code>#k=…&s=…`. When the host uses smurg's shared
relay, `<site>` is app.smurg.ai (the link is `https://app.smurg.ai/join/…`; https://smurg.ai is smurg's product page
and documentation and cannot open a workspace); when the host named another relay with `--relay` (their own, for
example), it is that relay's address. The part after `#` is the **secret** that lets you join the workspace: do not
repost the link in a group or in public, and do not copy only the part before the `#`.

1. Open the link in a browser (Chrome on a computer is the safest choice; Safari and Firefox have not been tested
   yet).
2. Log in: choose "**Log in with Google**" and use your Google account (another relay may also offer "Log in with
   GitHub"; whoever runs the relay decides which buttons appear). smurg uses the login only to know who you are and
   gets no access to your code; you do **not** need a Claude account or an API key. The relay knows which account
   you use and the IP address you connect from ([host guide](HOSTING.md) §2.1).
3. The page asks "Join this workspace?" and lists the workspace ID and your identity. If this is the link the host
   gave you, choose "**Join**". After you join, the host sees your name, your account
   and your device's name.
4. You are in the workspace: files on the left, the editor in the middle, agents and suggestions on the right, and
   "Activity", "Conflicts", "Transfers" and "Merge requests" at the bottom. The top bar shows who the host is, the
   connection state ("Connected") and your role.

The interface comes in English and Traditional Chinese: it starts in your browser's language, and the language menu
on the page switches it (the login and join pages have it too). Everyone sees the language they chose; this guide
quotes the English interface. Agent names (such as `Claude (Amy)`) and text that other people typed are never
translated.

Afterwards you open the workspace directly ("Recent workspaces" on the home page) and no longer need the invite
link: this browser remembers the key of the host's computer. A private window does not; once you close it, you need
a new invite link to join again.

**Should you check the key fingerprint?** While sharing, the host can run `smurg status` on their computer to see
the daemon key fingerprint. The first time you join, you can ask the host to read it to you over another channel (in
person, on the phone). If you see "**Security warning: connection refused**" or "The host computer's key has
changed", **do not go on yet**: someone may be posing as the host. It may also be that the host replaced the
workspace's keys (for example, shared again after taking Agent access back from a teammate, or reinstalled smurg).
Ask the host over another channel (in person, on the phone):

- The host says they did **not** replace anything: do not continue, choose "Cancel", and tell the host.
- The host says they did: ask for a new invite link, and ask them to read out the new daemon key fingerprint that
  `smurg status` shows. With the new link you see "The host computer's key has changed": once you are sure the link
  is the one the host just gave you, choose "I confirmed with the host: use the new link". If you join from a
  terminal, `smurg attach` prints the fingerprint of the invite link's key: type `y` only if it is the one the host
  read out (see §10).

Other things you may see:

| You see | What it means |
|---|---|
| "This invite link cannot be used" | The link expired, has no uses left or was revoked by the host. Ask the host for a new one. |
| "This browser already joined with another account" | A browser profile can be only one person in a workspace: the first time it joined, this browser was bound to the account logged in then. Log out and log in with that account again; to use another account, open the invite link in another browser profile or in a private window. |
| "You were removed from the workspace" | The host removed you from the workspace. To join again you need a new link from the host. |
| "Role changed" | The host changed your role; the page reconnects by itself with the new permissions. |
| "Server unreachable" | Your own network (or the relay) has a problem; the host is not offline. On smurg's shared relay, the free quota everyone shares may also be used up for today; it comes back after 00:00 UTC, 08:00 in Taiwan ([host guide](HOSTING.md) §2.1). |
| "Host offline" | See [§8](#8-what-host-offline-means). |

## 2. Roles: what you can do

The host chooses your role with the invite link and can change it later in the host console.

| | Viewer | Editor | Agent access |
|---|:-:|:-:|:-:|
| See files, download files or folders, watch every agent and terminal, read the activity feed | ✅ | ✅ | ✅ |
| Edit, create, rename, delete and upload files | ❌ | ✅ | ✅ |
| Send suggestions to a session | ❌ | ✅ | ✅ |
| Open agents or terminals on the host's computer (**they run as the host**) | ❌ | ❌ | ✅ |
| Type into **any** session; accept or reject the suggestions any session receives | ❌ | ❌ | ✅ |
| Work in a worktree and ask the host to merge it | ❌ | ❌ | ✅ |

Only the host can: invite members, change roles, remove members, read the audit log, force a file lock open and merge
a worktree.

**What Agent access means**: the sessions you open run on the host's computer **as the host**, with no sandbox: the
agent uses the host's Claude Code login (the usage and the cost are the host's), can run any command and can read the
files on the host's computer. That is why a host gives this role only to people they fully trust. You do not need
your own Claude account or API key, and you cannot use one.

Some files teammates **cannot see**: every `.git` folder, `.envrc`, smurg's own `.smurg/`, and the host's personal
Claude Code settings (`.claude/settings.local.json`, `CLAUDE.local.md`). Some files teammates **can see but not
change** (the file tree marks them "Only the host can change this file"): `.claude/` and `.mcp.json` (the host's
Claude Code reads them), `.vscode/`, `.idea/`. Apart from these, every member sees every file in the folder
(including configuration files such as `.env`). These limits apply to what people do in the web app and the CLI:
agents and terminals, which run as the host, are not bound by them.

## 3. Edit files together

- **Click a file** in the file tree on the left to open it in the editor; **right-click** a file or folder to create,
  rename, delete or download (a folder is packed into a zip). The buttons above the file tree create a file or a
  folder, or upload.
- **Everyone can type at the same time**; each person's cursor has its own color and name. An agent that changes a
  file shows up as `Claude (the person who opened it)`, for example `Claude (Amy)`.
- **There is no save button**: a moment after you stop typing, the file is saved to the host's computer (the editor
  says "Saved automatically"). If it keeps saying "Not saved yet: waiting for the host's computer", the connection
  usually has a problem.
- **Upload**: drag files or a whole folder onto the file tree on the left. Large files work too, and after a dropped
  connection the upload continues where it stopped; when the host's disk is too full, the upload is refused before
  it starts, with the reason. Progress is under "Transfers" at the bottom.
- Files that are too large (over 5 MB), binary or not UTF-8 cannot be opened in the editor; download them and open
  them with your own program.
- **Select some code** in the editor and choose "Send to agent" to send it to someone else's agent as a suggestion,
  or to paste it into your own agent (see §5).
- "Activity" lists, live, who (or which agent) created, changed, deleted or uploaded which file; click an entry to
  open the file. The file tree also marks files "Recently changed by …". Changes shown as "**Outside program**" are
  ones smurg cannot attribute to anyone (the host changed the file with another program, for example).

## 4. What the lock notices mean

smurg uses file locks so that people and agents do not overwrite each other. You see these notices above the editor
or in the file tree:

| Notice | What it means | What you can do |
|---|---|---|
| "You are editing this file, so agents cannot change it for now." | As soon as you started typing you got this file's **edit lock**: no agent can change it (the agent is told, always in English, "This file is being edited by <your name>. Work on other files first, or try again later."). Other people can still type with you. | Keep editing. The lock is released when you stop typing for 30 seconds (the host can change this) or close the file. To let an agent change it now, choose "**Let the agent go first**" (you get the lock back when you type again). |
| "You and Amy are editing this file (a shared edit lock), …" / "This file is being edited by Amy, …" | Several people share one edit lock; agents cannot change the file for now. | As above. |
| "Claude (Amy) is editing; you cannot type for now" | This agent is changing the file: the editor is **read-only** for the moment, and other agents cannot change it either. | Wait: when it is done (60 seconds at most by default), you can type again. What you type in the meantime is not accepted. |
| "Claude (Amy) editing" and "Editing: Amy" in the file tree | The two locks above. | |
| "This file is read-only for you" | Your role cannot edit, or it is a shared folder inside a worktree (read-only). | |
| "This file was deleted by …" / "This file was moved to …" | Someone deleted or moved the file you have open; this tab can no longer save. | "Create again from this content" or "Open the new location". |

**Conflicts**: an agent can also change a file without the file lock, with a terminal command (for example `sed`, a
formatter, `git checkout`). If it changes a place someone is editing, smurg **keeps what the person is typing**, puts
the agent's version in the "**Conflicts**" panel at the bottom and tells both sides. In the conflicts panel you
compare the two versions side by side and choose "Keep the text being edited", or "Apply this version…" to replace
the whole file with the other side's complete version.

## 5. Watch agents and send suggestions

- The **agent** area on the right has a tab for every session (for example, "Claude (Amy)" is an agent Amy opened, and
  "Terminal (Ian)" is a terminal the host Ian opened). Click a tab to watch it live, including
  what happened before you opened it.
- Members with the Viewer or Editor role can **only watch a session, not type** (it is marked "Watch only"). To get an
  agent to do something, send a **suggestion**: write your idea in the "Suggestions" box under the session (for
  example, "add tests for this function first") and choose "Send suggestion" (or press Ctrl + Enter). Members with
  agent access can type into any session directly (§6).
- A suggestion first waits in a list: the host and every member with agent access see "Suggestions waiting for your
  decision" under the session and can "Accept", "Edit and accept" or "Reject" it (with a reason, if they like); the
  text goes into the session only when someone accepts it. smurg never accepts by itself.
- You are told the result ("Your suggestion was accepted", "Your suggestion was rejected" and so on, with the reason
  if one was given). "My suggestions" shows the state of each one; a suggestion nobody has handled yet can be edited
  or withdrawn ("Edit", "Withdraw").
- Select code in the editor → "Send to agent" → send it as a suggestion to a session: the selected code is attached
  to the suggestion with the file name and the line numbers.
- The Viewer role can watch but cannot send suggestions.
- An agent can also notify you through smurg (for example, "Claude (Amy) notified you"); it appears under
  "Activity".

## 6. Open agent sessions (Agent access)

Only the **Agent access** role can open sessions on the host's computer and type into any session. The sessions you
open run on the host's computer **as the host**: with the host's operating-system account and the host's Claude Code
login, and no sandbox. So you **do not need to log in to Claude**, and you need no API key.

**Open a session**: "New session" at the top right of the agent area → choose a kind:

- "Agent (Claude Code)": runs Claude Code in a terminal.
- "Plain terminal": a shell, for running tests, builds and other commands.

Then choose where it works: "Shared main workspace" (changes the files everyone sees, protected by file locks), "A
new worktree of my own" or "Continue in the worktree I kept" (see §7), and choose "Open". The dialog reminds you:
"This session runs on the host's computer, and the agent uses the host's Claude account."  When Claude Code cannot be found
on the host's computer, an agent session cannot start and the page says why: tell the host.

**Using Claude Code**: click the terminal, type what you want it to do in plain sentences and press Enter. The screen
keeps updating while it works; Esc interrupts it and `/exit` ends it. Before it changes a file or runs a command it
may ask for permission: choose with the arrow keys and press Enter. **Everyone in the workspace sees** the session's
screen: never paste a password or an API key into a session.

**Typing into someone else's session**: you can also type directly into a session the host or another teammate
opened; everyone's input goes to the same terminal. When someone is typing, wait a moment, or send a suggestion.

**Remember**: everything you do in a session is done with the host's computer and the host's account. Agents spend the
host's Claude quota, commands run with the host's permissions and can read the files on the host's computer. Do only
what the host agreed to, and do not read files that have nothing to do with the project. When an agent shows that
Claude is not logged in (for example "Not logged in"), tell the host to log in; do **not** `/login` with your own
account in the session: that would store your credentials on the host's computer, and every agent would use them
from then on. The message "The host's Claude Code is not logged in, so this agent cannot work for now." means exactly
this.

**Attach from your own terminal**: a session's "Attach from your own terminal" lists the `smurg attach` commands
(§10).

## 7. Worktrees and merge requests

When the folder the host shares is a git repository, you can open a session in "**A new worktree of my own**": smurg creates a
separate working copy for you on the host's computer (on its own branch), and the agent changes files there without
disturbing everyone's main workspace. A worktree is only a place to work, not a restriction: an agent in it runs as
the host all the same.

- "Viewing" above the file tree switches between the main workspace and any worktree. Everyone can edit directly in
  a worktree too (with file locks, as usual).
- The **shared folders** the host named (for example a `data/` that is not in git) are linked into the worktree: in
  the web app they are read-only there; when an agent in the worktree writes into such a folder, it changes the one
  copy in the main workspace.
- When you end a session it asks "Keep the worktree of this session?": after "Keep the worktree" you can open a
  session in it again with "Continue in the worktree I kept"; "Delete the worktree" deletes it together with the
  changes not merged yet, and that cannot be undone.
- **When you are done, ask the host to merge**: switch the file tree to that worktree and choose "Ask the host to
  merge" (or "Request merge" under "Merge requests"); you can add a message. Members with agent access can make the
  request for any worktree. smurg turns all the current changes in the worktree into one commit; what you change
  afterwards needs a new request.
- The host sees the full diff and then chooses "Merge into the main workspace" or "Reject" (a rejected worktree stays as
  it is, and you are told the reason). When it conflicts with the main workspace, the merge stops, the main
  workspace is unchanged and the host decides what to do. You are told the result, and it also appears in everyone's
  "Activity".
- There is no way yet to bring later changes of the main workspace into your worktree.

## 8. What "Host offline" means

The host's `smurg host` is not running, the host's computer went to sleep (the laptop's lid was closed, for example),
or the host's network is down. Once the host goes offline, everyone sees "Host offline" within 10 seconds.

- Every file and session is on the host's computer, so until the host is back **changes to files are not saved and
  agents cannot be used**.
- When the host is back, the page **reconnects by itself**; you do not have to reload. What you typed in the editor
  while offline is not lost and is sent after the reconnect. You have to decide in one case only: the host's computer
  loaded the file again (the host's smurg restarted, for example) and its content differs from your version in a way
  that cannot be merged automatically. The page then says "You have changes that were not saved to the host's
  computer" and lets you choose "Replace with my version", "Copy my version" or "Discard my version".
- When the host's computer is awake and only you lost the connection, the sessions keep running on the host's
  computer; after you reconnect you see everything that happened.
- "The host stopped sharing this workspace" means the host ran `smurg stop`: every session has ended. When the host
  shares again, the page reconnects by itself.
- "Server unreachable" is something else: a network problem between you and the relay.

## 9. Leaving a workspace: what ends

"**Leave**" at the top right → confirm with "Leave".

**What ends** (within seconds): every session you opened (agents and terminals).

**What is not deleted**:

- Your **membership**: you are still in the host's member list and can open the workspace again later with the same
  browser. Only the host can remove you completely.
- The files you changed or created in the shared folder: they are part of the host's project.
- Your worktrees (including changes not merged yet): the host can remove them.
- Your suggestions, the activity feed and the audit log on the host's computer.

**Closing the tab or losing the connection** is not leaving: the sessions you opened keep running on the host's
computer. When the host removes you from the workspace, or changes your role to Editor or Viewer, the sessions you
opened end too.

## 10. Joining from a terminal (CLI, optional)

If you would rather not watch sessions in a browser, the `smurg` command attaches a session to a terminal on your own
computer (macOS or Linux). Install it first with one line (it is the same program the host uses; see the
[host guide](HOSTING.md) §1):

```sh
curl -fsSL https://smurg.ai/install.sh | sh
```

Then join:

```sh
smurg attach --invite -       # then paste the invite link and press Enter (it is not shown on screen)
```

smurg connects to the site in the invite link (the relay); you need no `--relay`. When this computer is not logged
in to that relay yet, it asks you to log in first: the terminal prints an address
(`https://app.smurg.ai/device`) and a code. Open the address in a browser on any device (a computer or a phone), log
in with your Google account, enter the code, and press "Allow" once the page shows your own account. **Press "Allow"
only if you yourself just ran smurg in a terminal; if someone else gave you the code, press "Deny".**

- **Use `--invite -`** (or the environment variable `SMURG_INVITE`). `smurg attach --invite https://…#k=…&s=…` works
  too, but then the secret in the link stays in your shell history and, while the command runs, shows in the process
  list (`ps`) that other users of the computer can read.
- A terminal is a new device, so it needs an invite link **the first time**. If the link your browser used has no
  uses left or expired, ask the host for a new link **with the same role you have now** (a link with another role
  does not work). Afterwards use `smurg attach --workspace <workspace code>` (not needed when you joined only one
  workspace).
- In a few setups the web app and the relay have different addresses (a development setup, for example). If smurg
  says you logged in to another address and not to the invite link's, add `--relay <relay address>` as it tells you
  (the host knows the address).
- When a login is needed, smurg also opens the address by itself on a computer with a desktop; over SSH, in a
  script or without a terminal it does not (`--no-browser` turns it off too). Open it on the computer or phone in
  front of you; SSH needs no other setup.
- After the host replaced the workspace's keys (§1, "Should you check the key fingerprint?"),
  `smurg attach --workspace …` stops and says that the key of the host's computer differs from the one it recorded.
  After checking with the host, run `smurg attach --invite -` with the new link the host gave you: smurg prints
  "The host computer's key has changed", the fingerprint it recorded and the fingerprint of the invite link's key,
  and asks whether to go on. Type `y` only if the invite link's fingerprint is the one the host sees with
  `smurg status`; any other input cancels, and nothing is sent. Outside a terminal (in a script, for example) it
  does not ask: add `--accept-new-key` once you have checked.

After joining:

```sh
smurg attach                  # lists the sessions in the workspace (number, kind, owner, state)
smurg attach 2                # attaches session 2 to this terminal; Ctrl-] detaches (the session keeps running)
```

Members with agent access can type into any session; other roles can only watch (smurg says "Read-only: …" first). When
the host goes offline, `smurg attach` tells you within seconds. To protect your terminal, a session's output is
filtered before it is shown: terminal queries, clipboard access (OSC 52) and other control sequences smurg does not
know are never sent to your terminal (someone else's agent could be tricked into printing them).

The CLI cannot open sessions or send suggestions, and it has no "Leave": use the web app for those.
