# Guide for teammates: join a shared workspace

This guide is for **teammates**: someone shared a project folder with smurg and sent you an invite link. You do not
need to have used smurg or Claude Code before. The host (the person who shares the folder) should read the
[host guide](HOSTING.md). This guide in [繁體中文](zh-TW/JOINING.md).

Four things to know first:

- **Every file is on the host's computer.** What you see and change in the browser is the file on the host's
  computer; saving is automatic.
- **Claude Code** is an AI coding assistant (called an **agent** below): you tell it what to do in plain sentences,
  and it reads files, changes code and runs commands. In smurg every agent runs on the host's computer, as the host,
  with the host's Claude account, and everyone in the workspace sees what it is doing, live.
- **Work is organized in topics.** A topic is one feature or task. Everyone discusses it with an agent that asks
  the team multiple-choice questions and writes a spec; the agent turns the spec into a plan of work items; one
  agent per work item does the work; people read each result report and mark it reviewed (§6).
- The connection between you and the host's computer is **end-to-end encrypted**: the server in between (the relay)
  cannot see file contents, conversations, terminal output or commands (it knows which account you logged in with and
  the IP address you connect from).

Contents: [1. Join](#1-join-with-an-invite-link) · [2. Roles](#2-roles-what-you-can-do) ·
[3. The main screen](#3-the-main-screen-inbox-sessions-and-columns) ·
[4. Code mode](#4-code-mode-edit-files-together) ·
[5. Talk to agents](#5-talk-to-agents-messages-suggestions-questions-and-votes) ·
[6. Topics](#6-topics-from-discussion-to-reviewed-result) ·
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
2. Log in: choose "**Log in with Google**" and use your Google account (another relay may also offer
   "Log in with GitHub"; whoever runs the relay decides which buttons appear). smurg uses the login only to know who
   you are and gets no access to your code; you do **not** need a Claude account or an API key. The relay knows which
   account you use and the IP address you connect from ([host guide](HOSTING.md) §2.1).
3. The page asks "Join this workspace?" and lists the workspace ID and your identity. If this is the link the host
   gave you, choose "**Join**". After you join, the host sees your name, your account
   and your device's name.
4. You are in the workspace. On the left are your inbox and the list of sessions, grouped by topic; on the right is
   room for up to four columns side by side: an agent's conversation, a spec, a plan, a result report (§3). The top
   bar shows who the host is, the connection state ("Connected"), your role, and a switch between "Sessions" (this
   screen) and "Code mode" (the file tree and the editor, §4).

The interface comes in English and Traditional Chinese: it starts in your browser's language, and the language menu
on the page switches it (the login and join pages have it too). Everyone sees the language they chose; this guide
quotes the English interface. Agent names (such as `Claude (Amy)`), the names of topics and work items, and text
that other people or agents wrote are never translated.

Afterwards you open the workspace directly ("Recent workspaces" on the home page) and no longer need the invite
link: this browser remembers the key of the host's computer. A private window does not; once you close it, you need
a new invite link to join again.

Once you have joined, you can read everything in the workspace, including every conversation with an agent that
took place before you came.

**Should you check the key fingerprint?** While sharing, the host can run `smurg status` on their computer to see
the daemon key fingerprint. The first time you join, you can ask the host to read it to you over another channel (in
person, on the phone). If you see "**Security warning: connection refused**" or
"The host computer's key has changed", **do not go on yet**: someone may be posing as the host. It may also be that
the host replaced the workspace's keys (for example, shared again after taking Agent access back from a teammate, or
reinstalled smurg). Ask the host over another channel (in person, on the phone):

- The host says they did **not** replace anything: do not continue, choose "Cancel", and tell the host.
- The host says they did: ask for a new invite link, and ask them to read out the new daemon key fingerprint that
  `smurg status` shows. With the new link you see "The host computer's key has changed": once you are sure the link
  is the one the host just gave you, choose "I confirmed with the host: use the new link". If you join from a
  terminal, `smurg attach` prints the fingerprint of the invite link's key: type `y` only if it is the one the host
  read out (see §10).

Other things you may see:

| You see | What it means |
|---|---|
| "This invite link cannot be used" | The link expired, has no uses left or was revoked by the host: ask the host for a new one. One more case: you are already a member, and the link is for another role than yours (the host's link for teammates is usually an Editor link). In a browser that had joined before and needed the link only because of "The host computer's key has changed", the new key was recorded all the same: open the workspace again without the link ("Recent workspaces" on the home page). On a new device, ask the host for a link of your own role. |
| "This browser already joined with another account" | A browser profile can be only one person in a workspace: the first time it joined, this browser was bound to the account logged in then. Log out and log in with that account again; to use another account, open the invite link in another browser profile or in a private window. |
| "You were removed from the workspace" | The host removed you from the workspace. To join again you need a new link from the host. |
| "Role changed" | The host changed your role; the page reconnects by itself with the new permissions. |
| "Server unreachable" | Your own network (or the relay) has a problem; the host is not offline. On smurg's shared relay, the free quota everyone shares may also be used up for today; it comes back after 00:00 UTC, 08:00 in Taiwan ([host guide](HOSTING.md) §2.1). |
| "Host offline" | See [§8](#8-what-host-offline-means). |

## 2. Roles: what you can do

The host chooses your role with the invite link and can change it later in the host console.

| | Viewer | Editor | Agent access |
|---|:-:|:-:|:-:|
| See files, download files or folders, read every conversation, spec, plan and result report, watch every terminal | ✅ | ✅ | ✅ |
| Be mentioned by other members (it shows in your inbox) | ✅ | ✅ | ✅ |
| Edit, create, rename, delete and upload files; edit a topic's spec and plan | ❌ | ✅ | ✅ |
| Vote and comment on an agent's questions; mention people | ❌ | ✅ | ✅ |
| Send suggestions to an agent (it gets them only when someone with agent access accepts) | ❌ | ✅ | ✅ |
| Be the responsible person of a session or a work item; review a result report | ❌ | ✅ | ✅ |
| Start a topic, ask for the plan, start work items, open agent sessions and terminals (**they run as the host**) | ❌ | ❌ | ✅ |
| Send messages to any agent, stop it, answer an agent's question in your own words | ❌ | ❌ | ✅ |
| Allow or deny what an agent asks to run; accept or reject suggestions | ❌ | ❌ | ✅ |
| Type into **any** terminal session | ❌ | ❌ | ✅ |
| Ask the host to merge a worktree | ❌ | ❌ | ✅ |

Only the host can: invite members, change roles, remove members, read the audit log, force a file lock open, merge
a worktree, allow a request that reaches beyond the project, confirm the folder's Claude Code settings, and delete a
topic.

**What Agent access means**: the agents you start and the terminals you open run on the host's computer **as the
host**, with no sandbox: an agent uses the host's Claude Code login (the usage and the cost are the host's), and
what you allow it to run can do whatever the host's account can do. That is why a host gives this role only to
people they fully trust. You do not need your own Claude account or API key, and you cannot use one.

Some files teammates **cannot see**: every `.git` folder, `.envrc`, smurg's own `.smurg/`, and the host's personal
Claude Code settings (`.claude/settings.local.json`, `CLAUDE.local.md`). Some files teammates **can see but not
change** (the file tree marks them "Only the host can change this file"): `.claude/`, `.mcp.json` and every
`CLAUDE.md` (the host's Claude Code reads them as settings and instructions), `.vscode/`, `.idea/`. While the host
uses the folder's Claude Code settings, teammates cannot change the scripts those settings run either; the file
tree does not mark these, and the change is refused. A folder that holds a file only the host may change, or a
hidden one, at any depth cannot be renamed or deleted by teammates: that would move the file with it. It can be a
folder you do not expect, such as `node_modules` when a package in it ships a `CLAUDE.md` or a `.vscode` folder.
You are told "Only the host can change this path."; ask the host to do it.
Apart from these, every member sees every file in the folder (including configuration files such as `.env`).
These limits apply to what people do in the web app and the CLI. Agents are kept from the hidden files too, but a
command that someone allows, and any terminal, runs as the host and is not bound by them.

## 3. The main screen: inbox, sessions and columns

The screen you arrive at is the sessions view (the "Sessions" side of the switch in the top bar).

**The inbox** (top left) holds what waits for you, in two groups:

- "Agents are waiting": an agent, or a whole plan, is stopped until someone acts. These are an agent's question you
  decide, a vote that is open, a permission request you may answer, and work that stopped and needs someone (an
  agent that stopped without its report, a work item that failed or did not start, a plan paused after a restart).
- "For you to look at": suggestions for sessions you look after, result reports for you to review, changes ready to
  merge (the host), mentions of you, and what became of your own suggestions.

The inbox shows two counts, how many items are waiting and how many are to look at. While you are in code mode the
same two counts are on the "Sessions" side of the switch; the browser tab's title shows only how many are waiting.
What you should know about it:

- **An item is a thing that waits, not a message.** It leaves when the thing is settled, whoever settles it, for
  everyone at the same moment. You cannot dismiss it. Only a mention, and the note about your own suggestion, can
  be dismissed, and these two also leave as soon as you open them. Opening any other item only takes its bold away.
- **Whose inbox**: an agent's question goes to the person who decides it (§5.3); a permission request and a
  suggestion to the session's responsible person when that person may answer them, otherwise to the host and every
  member with agent access; a result report to whoever reviews it (§6). When the person who must answer a question
  or a permission request does not (5 minutes by default, or they have been offline for a minute), it also appears
  for the host and the members with agent access, who can act in that person's place. A result report does the same
  after six times that long (30 minutes by default). A suggestion stays in the inbox it went to; the host and every
  member with agent access can still accept it on its card.
- A Viewer gets only mentions: "Nothing is waiting for you. As a viewer you get only mentions here."
- A new item in "Agents are waiting" also shows a short notice with "Open" when its session is not on your screen.

**The session list** (below the inbox) is grouped by topic. A topic's rows are fixed: "Discussion" (the session
everyone shares), "Spec", "Plan", then one row per work item once the plan exists. Sessions that belong to no topic
are in the group "No topic"; a terminal session has a terminal icon. Above the list, "New" starts a topic, a single
agent session or a terminal (Agent access and the host), and a filter shows "All", "Mine" or "Waiting". A row in bold
means something happened there since you last had it on screen.

Each session shows what it is doing:

| Status | What it means |
|---|---|
| "Running" | The agent is working. |
| "Waiting for an answer" | The agent asked a question and waits for the answer. A person must act. |
| "Waiting for permission" | The agent asked to run something and waits. A person must act. |
| "Stopped without a report" | A work item's agent stopped before it wrote its result report. A person must look. |
| "Idle" | The agent finished its turn and waits for the next message. A discussion is in this state most of the time. |
| "Done" | The work item is finished and its result report is written. |
| "Failed" | The agent's process ended with an error. It can be tried again. |
| "Ended" | Someone ended the session, or it ended by itself: a work item's session ends when the item is merged and reviewed, and a topic's sessions end when the topic is archived. Its conversation stays readable (for a session without a topic: for 30 days). |

**Columns** (the right side) are your own view; nobody else sees what you have open.

- Click a row or an inbox item to open it as a column. "Open to the side" (the button on the row, Shift+click or
  Shift+Enter) adds a column next to the one you are reading instead of replacing it.
- Up to four columns fit side by side, with dividers you can drag. A fifth is refused:
  "Four columns are open. Close one first."
  When the window is too narrow for all of them, the ones that do not fit are reached with the button at the edge
  of the columns (`1 more`).
- "Pin column" keeps a column from being replaced; the plan of a topic that is being carried out is pinned by itself.
- Closing a column never ends a session.
- The left side folds: the inbox and the session list each collapse, and the whole left column can shrink to a
  narrow strip that shows one count: how many items are waiting or, when nothing waits, how many are to look at.

## 4. Code mode: edit files together

"Code mode" in the top bar switches to the file tree and the editor; "Sessions" switches back. Both sides keep
their state: the columns you had open are still there when you return. While you are in code mode, the inbox counts
stay visible on the switch.

- **Click a file** in the file tree on the left to open it in the editor; **right-click** a file or folder to create,
  rename, delete or download (a folder is packed into a zip). The buttons above the file tree create a file or a
  folder, or upload.
- **Everyone can type at the same time**; each person's cursor has its own color and name. An agent that changes a
  file shows up under its own name, for example `Claude (Cart API)` for the agent of a work item named Cart API.
- **There is no save button**: a moment after you stop typing, the file is saved to the host's computer (the editor
  says "Saved automatically"). If it keeps saying "Not saved yet: waiting for the host's computer", the connection
  usually has a problem.
- **Upload**: drag files or a whole folder onto the file tree on the left. Large files work too, and after a dropped
  connection the upload continues where it stopped; when the host's disk is too full, the upload is refused before
  it starts, with the reason. One upload can have at most 10,000 folders, counting every folder its files lie in;
  a larger one is refused before anything is created ("Upload it in parts."). Progress is under "Transfers" at the
  bottom.
- Files that are too large (over 5 MB), binary or not UTF-8 cannot be opened in the editor; download them and open
  them with your own program.
- **Names smurg does not accept.** A file or folder is not listed, and cannot be opened, created or uploaded, when
  its name has a control character, a backslash or a character that changes the direction of the text in it, or
  more than 30 accents stacked on one letter. No word of any language needs that many. Agents and terminals, which
  run as the host, see such a file like any other.
- **A session beside the editor**: the right side of code mode shows one agent session of your choice, the same
  conversation as in the sessions view. A file that an agent read or changed has "Open in editor" in the
  conversation; it brings you here with that file open, and "Back to the session" returns.
- **Select some code** in the editor and choose "Send to agent" to put it into a message for an agent, with the file
  name and the line numbers (a suggestion when your role is Editor, see §5).
- "Activity" at the bottom lists, live, who (or which agent) created, changed, deleted or uploaded which file; click
  an entry to open the file. The file tree also marks files "Recently changed by …". Changes shown as
  "**Outside program**" are ones smurg cannot attribute to anyone (the host changed the file with another program,
  for example). "Terminal" at the bottom holds the plain terminal sessions (§5.5).
- "Viewing" above the file tree switches between the main workspace and the worktrees (§7).

### 4.1 What the lock notices mean

smurg uses file locks so that people and agents do not overwrite each other. You see these notices above the editor
or in the file tree; they also appear when you edit a spec or a plan in a column:

| Notice | What it means | What you can do |
|---|---|---|
| "You are editing this file, so agents cannot change it for now." | As soon as you started typing you got this file's **edit lock**: no agent can change it (the agent is told, always in English, "This file is being edited by <your name>. Work on other files first, or try again later."). Other people can still type with you. | Keep editing. The lock is released when you stop typing for 30 seconds (the host can change this) or close the file. To let an agent change it now, choose "**Let the agent go first**" (you get the lock back when you type again). |
| "You and Amy are editing this file (a shared edit lock), …" / "This file is being edited by Amy, …" | Several people share one edit lock; agents cannot change the file for now. | As above. |
| "Claude (Amy) is editing; you cannot type for now" | This agent is changing the file: the editor is **read-only** for the moment, and other agents cannot change it either. | Wait: when it is done (60 seconds at most by default), you can type again. What you type in the meantime is not accepted. |
| "Claude (Amy) editing" and "Editing: Amy" in the file tree | The two locks above. | |
| "This file is read-only for you" | Your role cannot edit, it is a file only the host may change, or it is a folder that is read-only inside a worktree (a shared folder, or a topic's `specs/` folder in a work item's worktree). | |
| "This file was deleted by …" / "This file was moved to …" | Someone deleted or moved the file you have open; this tab can no longer save. | "Create again from this content" or "Open the new location". |

**Conflicts**: a program can also change a file without the file lock (the host's own editor, or a command an agent
was allowed to run, such as `sed`, a formatter or `git checkout`). If it changes a place someone is editing, smurg
**keeps what the person is typing**, puts the other version in the "**Conflicts**" panel at the bottom of code mode
and tells both sides. In the conflicts panel you compare the two versions side by side and choose
"Keep the text being edited", or "Apply this version…" to replace the whole file with the other side's complete
version. Open conflicts show as a count on "Code mode" in the top bar.

## 5. Talk to agents: messages, suggestions, questions and votes

An agent session is a conversation, and everyone reads all of it, including what happened before they opened it.
You see people's messages with their name and role, the agent's answers, and one line for each thing the agent
did ("Read", "Edited", "Created", "Ran", "Searched"), which you can open to see the change or the output. Things
that wait for people are cards in the conversation: questions, permission requests, suggestions.

Above the conversation a strip shows who is responsible for the session ("Responsible: Ian", or
"Responsible: nobody"), where the agent works (the main workspace or a worktree) and what it may do without asking
(for example "Asks before commands"; a topic's discussion shows "Reads code, writes only the spec and the plan").
The line above the message box says what the agent is doing or what it waits for (for example "Claude is idle.").

**Links in what an agent or a member wrote.** A link opens in a new tab, and it shows where it leads when you rest
the pointer on it or reach it with the keyboard. Images are never loaded: an image is a link to it. When the words
of a link name another place than the link leads to, smurg does not draw them as the link: it writes the words as
text and the real destination after them, as the link: `github.com (https://evil.example/)`. It does the same,
wherever the link leads, when a dotted name in the words has a letter from outside the English alphabet in it (a
look-alike letter in a well-known name, an umlaut), or a character nobody can see beside its dot. This is a help,
not a guarantee. smurg reads words as a place when they are an address, a name with a path behind it, or a bare
name under one of about fifty well-known endings (`.com`, `.org`, `.io`, `.tw` …). It draws an ordinary link, with
the destination behind the pointer and the keyboard only, for:

- a bare name under any other ending (`amazon.in`, `bbc.it`, `github.lol`): no spelling tells it from a file name
  such as `README.md`;
- a name in which the dot is a sign that only looks like one (a raised dot, a digit zero of another script), or
  that has a character drawn with almost no width before the dot;
- a name written backwards behind a character that turns the direction of the text. smurg removes such a
  character from a message, so this can only happen in a spec or another file;
- words that are exactly the name of the file the link leads to, whatever letters they are written in (so that
  `résumé.pdf` can link to that file). A look-alike name under a less common ending passes this way when the
  link's own address ends in it.

So before you follow a link, look at where it leads.

**Text that cannot be formatted in time.** What agents and people write is shown formatted (headings, lists, code).
A text that is too long or too deeply nested, or that takes too long to format, is shown as it was written, under
the note "Shown as it was written: this text is too long or too deeply nested to format." A spec is formatted
section by section: the section the time ran out on is shown as written and the rest is formatted, and when the
time runs out a second time the whole spec is shown as written. When very many texts arrive at once, the ones
that have to wait are shown as written for a moment, without the note, and are formatted as soon as the browser
has time, the ones on screen first.

### 5.1 Messages (host and Agent access)

- Write in the box ("Message Claude") and press Enter; Shift+Enter makes a new line. While the agent works, it
  reads your message at its next step. Type `@` to mention a member.
- The agent is told who wrote each message (your name and role). Everything smurg itself tells an agent is in
  English, whatever language you use; you can write to the agent in any language.
- "Stop" ends what the agent is doing now; the session stays open. Ending a session for good is in the column's
  menu ("End session…"), for the host and for the member with agent access who opened the session or is
  responsible for it; it also ends what the agent's commands left running (a dev server, a watcher). A topic's
  discussion cannot be ended, only restarted (§6).
- A message reaches the agent as you wrote it. Claude Code's own slash commands are not available: a message that
  starts with `/` is read as text. `@path` is not replaced by the file's content either: to show the agent a file,
  name its path, and it reads the file with its own tools (and asks when that needs permission). Agents start no
  subagents in this version.
- A text you have not sent yet stays in the box. It is kept in this browser, per session, until you send it, leave
  the workspace, log out or are removed.
- **Remember**: an agent works on the host's computer with the host's account and spends the host's Claude usage.
  Ask it only for what the host agreed to, and never paste a password or an API key into a conversation: every
  member reads it.

### 5.2 Suggestions (Editor)

- As an Editor you use the same box; it says "Suggest to Claude" and its button is "Send suggestion". The line
  under it says who will get it, for example "Goes to Ian as a suggestion. It reaches the agent only when accepted."
- Your suggestion appears as a card in the conversation ("Suggestion from Amy") and in the inbox of the session's
  responsible person, or of the host and the members with agent access. They choose "Accept", "Edit and accept" or
  "Reject" (with a reason, if they like). "It reaches the agent only when someone accepts it." smurg never accepts
  by itself.
- When it is accepted, it becomes your message in the conversation, marked "suggestion, accepted by Ian", and the
  agent reads exactly the text that was shown. When it is rejected, or accepted after an edit, the card says so and
  you get a note in your inbox.
- Until someone decides, you can change it ("Edit") or take it back ("Withdraw"). You can have 20 suggestions
  waiting in one session.
- Characters that cannot be seen are removed from what you write before it is stored and shown
  ("Hidden characters were removed"): what a person accepts is exactly what the agent gets. More than 30 accents
  stacked on one letter are cut to the first 30 in the same way; this goes for every text a person writes in a
  conversation (a message, a suggestion, a comment, an answer, a note).
- The same goes for the other boxes that send text to an agent, such as "Ask the agent to revise" on a spec and the
  box under a result report: an Editor's text there is a suggestion too.
- Suggestions go to agent sessions only, not to terminals. A Viewer cannot send suggestions:
  "As a viewer you can watch this session. You cannot send messages, make suggestions or vote."

### 5.3 Questions and votes

Agents are told to bring decisions to the team as multiple-choice questions. A question is a card,
"Question from Claude", and the agent waits until it is answered.

- **Everyone but Viewers votes** ("Your vote"). You see each other's choices live and can change yours until the
  answer is submitted. The option with the most votes is marked "Leading". "Other" lets you vote for an answer in
  your own words.
- **Comments** go under the options; `@name` mentions someone. "Comments are for the team. Claude does not read them."
- **One person decides**, and the card says who: the session's responsible person; when nobody is assigned, the
  person who opened the session or pressed Start (for a topic's discussion: whoever created the topic, or started
  the discussion again); the host if
  that person is gone. The votes are advice: the person who decides clicks an option and presses "Submit answer",
  also against the vote ("You can submit now; votes are advice."). With a tie nothing is prefilled:
  "The vote is tied. Choose the answer yourself."
- **What the agent receives**: the answer and how the vote went. Not the comments, and not other people's own
  answers. A person who decides and has agent access can add a "Note for Claude (optional)", and can copy a comment
  into it with "Add to the note". An Editor who decides chooses among the agent's options; an answer in their own
  words needs someone with agent access ("Ask them to submit").
- While a question is open in a session nobody is assigned to (a topic's discussion is one unless someone was made
  responsible for it), it is in the inbox
  of everyone who has not voted yet. The person who decides, and the host, can press
  "Remind those who have not voted".
- **When the person who decides does not answer** for the waiting time (5 minutes by default), or has been offline
  for a minute, the host and the members with agent access can submit in their place ("Submit for Ian"); the
  conversation records it.
  The host can always submit.
- An agent can ask several questions in one card; each has its own votes, and one button submits them all. An
  answered card folds to a few lines: the answer of each question, who submitted it and the note for the agent
  ("Show the votes and comments" opens the rest), so a discussion's decisions read as a list.

### 5.4 Permission requests

Outside its own worktree, and for almost every command, an agent must ask first. The card
("Claude asks for permission to run a command") shows the whole command and where it would run.

- The host and members with agent access answer: "Allow once", "Always allow this kind" or "Deny" (with a line that
  tells the agent what to do instead, if they like). Editors and Viewers see the request and who it waits for.
- If you may answer: read the command first. What you allow runs on the host's computer as the host. Nothing of a
  request is hidden: a character nobody can see is written out as a mark, and a long command or diff stands in a
  box that scrolls. The card says how many lines such a box has, and you can allow only after you scrolled it to
  its end: "Allow is available once you have scrolled to the end of what is asked."
- "Always allow this kind" is offered only for narrow kinds of commands, "in this session" or
  "in every session of this topic"; it also covers the same command after the agent changed the files it runs. It
  is not offered for a command made of several (`pnpm test && git push`): a kind names one command.
- Some requests say "Only the host can allow this: it reaches beyond the shared project."
- In a folder whose Claude Code settings run scripts, smurg itself asks before an agent's shell command that could
  change one of those scripts, also inside the agent's own worktree and whatever is always allowed. The card gives
  smurg's reason, in your language, where it otherwise gives Claude Code's; when the command writes where such a
  script is, only the host can allow it.
- The first answer wins; the card then says who allowed or denied it.

### 5.5 Terminal sessions

A plain terminal is a shell on the host's computer, for running tests, builds and other commands by hand. The host
and members with agent access open one with "New" in the session list ("Terminal") and can type into any terminal
session; Editors and Viewers can only watch it (it is marked "Watch only"). A terminal opens as a column like any session, and in
code mode under "Terminal" at the bottom. Everything typed there runs as the host: never paste a password into it.
"Attach from your own terminal" lists the `smurg attach` commands for it (§10).

## 6. Topics: from discussion to reviewed result

A topic takes one feature or task from the first conversation to work that someone has read and understood. Each
step is a row of the topic in the session list.

1. **New topic** (host and Agent access): "New topic" asks for a name and, if you like, what you want to build. It
   says what it does: "Start discussion" opens an agent on the host's computer, with the host's Claude account,
   that may read the code and write only the topic's folder (`specs/<folder>/` in the project).
2. **Discussion**: one session per topic that everyone shares. Everyone but Viewers talks with the agent (Editors
   through suggestions, §5.2); the agent asks its questions as cards and everyone but Viewers votes (§5.3). When
   the team has said enough, the host or a member with agent access can choose "Write the spec now".
3. **Spec**: the agent writes `SPEC.md` in the topic's folder and says so in the discussion ("Open spec"). In the
   spec column you read it, or switch to editing and type in it together with the others (file locks as in §4.1:
   while someone types, the agent waits its turn). "Ask the agent to revise" sends what you want changed to the
   discussion, where everyone sees it and the agent may ask a new question first. In a very large spec with
   sections that take too long to format (§5), the first keystrokes can each take most of a second, until every
   such section has been set aside.
4. **Plan**: "Generate plan" (host and Agent access) makes the agent write `PLAN.md`: a list of **work items**, each
   with a title, a description and the items it must wait for. smurg checks the format; if it cannot read the work
   items, the plan says which line is wrong. When the spec changes later, the plan says so and offers "Update plan".
5. **Who is responsible**: the agent suggests who looks after which work item among the members with agent access
   who are present, and smurg fills in what it leaves open; "Suggest again" computes it anew. The host and the
   members with agent access change it item by item, or choose "No one assigned: everyone watches"; Editors and
   Viewers read who is responsible. The responsible person of an item gets its agent's
   questions, permission requests and result report in their inbox. Being responsible gives no extra rights: an
   Editor who is responsible decides questions among the agent's options and reviews the report, while commands
   are still allowed by members with agent access.
6. **Start** (host and Agent access): before anything runs, a dialog lists what Start will do: which items start
   now and which wait for others, who is responsible, who edited the spec and the plan by hand since the last
   Start, and that smurg commits the two files to the host's repository. Starting needs the shared folder to be a
   git repository with at least one commit, and git 2.42 or later on the host's computer; the dialog says what is
   missing and what the host can do. The folder can become a repository while it is shared: once the host has run
   `git init` and committed, Start works the next time it is opened.
7. **Execution**: every started work item is an agent session of its own, in its own worktree (§7), and shows up
   as a row of the topic. Its agent edits files in its worktree without asking and asks before commands (§5.4). The
   plan column stays the overview: what runs, what waits for a person, what waits for a merge. An item that waits
   for others starts by itself when those are merged, and only while the spec and the plan are still the ones that
   were confirmed at Start; if they changed, it waits for someone to look at the change and choose "Start again".
8. **Result report**: when a work item is done, its agent writes a report with fixed sections: "What was done",
   "Why it was done this way", "How it was verified" (each check either passed or not verified),
   "What to watch out for" and "Changes" (every changed file, with its diff). A report also says how the work
   ended: "Complete", "Partial" or "Blocked". Under it you can ask about the result or say what to change
   ("Ask about this result, or tell Claude what to change"); the question goes to the item's session and the answer
   shows in both places. When the item is finished (merged and reviewed), the box is gone:
   "This item is merged and its session has ended. Ask in the discussion."
9. **Review**: "I've reviewed this" is for the item's responsible person; when nobody is assigned, anyone but a
   Viewer can press it, once, for all. It means: I read the report and understand the change. A report that says
   "Partial" or "Blocked" asks once more before it counts ("Mark as reviewed"). If the agent changes the report
   afterwards, it asks for a review again.
10. **Merge**: reviewing does not merge. A reviewed item's changes go to the host's inbox by themselves
    ("Reviewed, ready to merge"), and the host merges them into the main workspace after reading the diff (§7).
11. **Topic complete**: when every work item is reviewed, the topic is "Complete". "Archive topic" puts it away;
    its files stay in the project and its conversations stay readable ("Show archived topics").

When something stops, it shows, and someone gets it in their inbox:

- "Stopped without a report": an agent ended its turn without its report, although smurg asked it once more.
  "Continue" asks it to go on. The plan and the inbox say so when the reason was another one: a person stopped
  the agent, smurg was restarted, or an error. One such error is that smurg could not record the item's changes
  with the report (someone kept typing in the worktree, for example); the conversation says so, and the report
  appears when the agent's next turn ends.
- "Failed": the agent's process ended with an error. "Try again" continues the same conversation. After three
  failed starts in a row only the host can try again.
- The host's Claude account ran out of usage, or Claude Code on the host's computer is logged out: the sessions
  say so and wait; only the host can fix it.
- After the host's smurg was restarted, nothing runs by itself (§8).
- A discussion that has grown long offers "Start a fresh conversation": a new discussion that starts from the spec
  and the plan as they are. The earlier one stays in the list as "Earlier discussion".

How well an agent follows this flow depends on the model. smurg checks the plan and the report format itself and
asks the agent to correct them, and it puts stopped work into an inbox; but the flow of this version was tested
with a scripted stand-in for the model, not with a real Claude account, so expect rough edges and tell the host
when a step does not work.

## 7. Worktrees and merge requests

A worktree is a separate working copy of the project on the host's computer, on its own branch. Agents change files
there without disturbing the main workspace that everyone shares. A worktree is only a place to work, not a
restriction: what runs in it runs as the host all the same.

- **Every work item has its own worktree**; smurg creates it when the item starts (for an item that waits for
  others: once those are merged) and removes it when the item is merged and reviewed, once nothing unmerged is
  left in it. While the worktree still holds changes that no merge carried (a follow-up after the merge, edits
  made after the last report), the item keeps its session and its worktree. A single agent session without a
  topic can work in a worktree too, or in the main workspace.
- "Viewing" above the file tree in code mode switches between the main workspace and any worktree. Everyone who may
  edit can edit code in a worktree too (with file locks, as usual); the result report then says which files were
  also edited by hand, and by whom (renaming, moving or deleting a folder counts for every changed file below
  it). Inside a work item's worktree the topic's `specs/` folder is read-only for
  everyone: it holds the spec and the plan the agent started from, and the agent's report.
- The **shared folders** the host named (for example a `data/` that is not in git) are linked into every worktree:
  in the web app they are read-only there; when an agent in the worktree writes into such a folder, it changes the
  one copy in the main workspace.
- **You read a work item's changes in its result report**: every file with its diff, as one change. A file that
  teammates cannot see (§2) is listed there without its content.
- **Merging is the host's decision.** A reviewed report's changes are in the host's inbox by themselves. For a work
  item whose report nobody reviewed yet, a member with agent access chooses "Request merge" under the report. For
  the worktree of your own session without a topic, switch "Viewing" in code mode to that worktree and choose
  "Ask the host to merge" (only the member who owns the worktree has this button). The host reads the full diff and
  then chooses "Merge into the main workspace" or "Reject" (a rejected worktree stays as it is, and the reason is
  shown).
- **When a merge conflicts** with the main workspace, it stops and the main workspace is unchanged. The host or a
  member with agent access can then choose "Ask the agent to resolve": smurg brings the main workspace's changes
  into the item's worktree, the item's agent resolves the conflicting places and writes a new version of its
  report. That report has to be reviewed again; then the change is back in the host's inbox.
- When you end an agent session without a topic that worked in a worktree, you are asked whether to keep its
  worktree; deleting it deletes the changes that were not merged, and that cannot be undone.

## 8. What "Host offline" means

The host's `smurg host` is not running, the host's computer went to sleep (the laptop's lid was closed, for example),
or the host's network is down. Once the host goes offline, everyone sees "Host offline" within 10 seconds.

- Everything is on the host's computer, so until the host is back **changes to files are not saved, nothing can be
  sent to an agent, and votes and answers cannot be given**. Everything stays readable. Agents that were waiting
  for a person keep waiting on the host's computer.
- When the host is back, the page **reconnects by itself**; you do not have to reload. What you typed in the editor
  while offline is not lost and is sent after the reconnect. You have to decide in one case only: the host's computer
  loaded the file again (the host's smurg restarted, for example) and its content differs from your version in a way
  that cannot be merged automatically. The page then says
  "You have changes that were not saved to the host's computer" and lets you choose "Replace with my version",
  "Copy my version" or "Discard my version".
- When the host's computer is awake and only you lost the connection, the agents keep working on the host's
  computer; after you reconnect you see everything that happened.
- "The host stopped sharing this workspace" means the host ran `smurg stop`: terminal sessions have ended, and
  agent sessions are paused. When the host shares again, the page reconnects by itself.
- **After the host's smurg was restarted**, every conversation is readable and every agent is idle, but nothing
  runs by itself: plans are paused ("smurg was restarted on the host's computer."), and the host or a member with
  agent access chooses "Continue all". A question that was open is asked again when its session continues, and a
  message that was still waiting for its agent ("Claude reads it when it starts again") is delivered then.
- "Server unreachable" is something else: a network problem between you and the relay.

**When smurg was updated: the screens about versions.** The page you use comes from the relay and is replaced there
with each new version of smurg; the host's `smurg` is updated by the host. The two must speak the same protocol
version, so around an update you may meet one of these screens. Each says who has to do something:

- "This tab is from before an update": smurg was updated while your tab was open, and the tab still runs the page
  from before. Reload the page. You stay a member and need no new invite link.
- "The host's smurg is older than this page": your page is the newest one, and the host has not updated yet. There
  is nothing for you to do but tell the host: the host stops sharing, runs `smurg update` and shares again (a host
  who runs their own relay also deploys it again). Then reload the page.
- "Incompatible versions": shown for the moment in which the page finds out which of the two it is, and when it
  cannot ask the relay. It then names both steps: reload first, and if the page says the same again, the host has to
  update.
- "smurg was updated", in a column, in a panel or as the whole page, with the button "Reload the page": a part of
  the page that your tab had not loaded yet was replaced by the update. Reload; if the host has not updated yet, the
  page says so then.
- "This browser's smurg key was written by a newer page": this browser was already used with a newer page of
  smurg, and this tab is an older one. Nothing was changed. Reload the page to get the newer one.

If one of these screens came while you were joining through an invite link, reload all the same: the page kept the
link and asks "Join this workspace?" again. Only a browser that blocks site data cannot keep it; open the invite
link again there.

An update of the host's smurg keeps the workspace: its members, their roles and their devices are carried over,
from 0.4.0 too. You do not join again, and you are not asked about the host's key. If your page says
"Security warning: connection refused" after the host updated, or a link asks "The host computer's key has changed",
check the fingerprint with the host as in §1 and ask for a link: a host who went from 0.4.0 to 0.5.0 may have had to
start the workspace anew, and may since have gone back to the earlier one.
Since 0.5.0 the roles do more than they did in 0.4.0, and you have today's meaning of the role you had (§2).

## 9. Leaving a workspace: what ends

"**Leave**" at the top right → confirm with "Leave".

**What ends** (within seconds): the terminal sessions you opened, and the agent sessions you opened that belong to
no topic. The worktrees of those sessions are kept, with their changes, and stay yours: you find them when you
open the workspace again.

**What passes to the host**: the sessions of topics that you created or started. They keep running, now looked
after by the host, so a plan does not stop because you left. Questions you would have decided are decided by the
next person in line or by the host.

**What is removed with you**: your votes on questions that are still open, your messages that an agent has not read
yet, the kinds of commands you always allowed, and a permission mode you loosened. Work items you started that have
not begun yet do not start until someone starts them again.

**What is not deleted**:

- Your **membership**: you are still in the host's member list and can open the workspace again later with the same
  browser. Only the host can remove you completely.
- The files you changed or created in the shared folder, and everything in a topic's folder: they are part of the
  host's project.
- The conversations you took part in, the activity feed and the audit log on the host's computer.

**Closing the tab or losing the connection** is not leaving: nothing ends, and what waits for you keeps waiting
(after a while the host and the members with agent access can answer in your place).

When the host changes your role so that you can no longer use agents, the same things end, pass to the host and
are removed (your votes stay while you may still vote), and the worktrees you had kept pass to the host too: you
can no longer remove them. When the host removes you from the workspace, the same happens, the topic sessions you
started are stopped before they pass to the host, and your suggestions that nobody decided are closed.

## 10. Joining from a terminal (CLI, optional)

The `smurg` command can attach a **terminal session** of the workspace to a terminal on your own computer (macOS or
Linux). Agent sessions are conversations and open in the browser only; the command lists them. Install it first
with one line (it is the same program the host uses; see the [host guide](HOSTING.md) §1):

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
  does not ask: add `--accept-new-key` once you have checked. If your role is not the link's (the host's link for
  teammates is usually an Editor link), smurg then says
  "The invite link is not valid, has expired or has been used up; ask the host for a new one." The new key was
  recorded all the same: run `smurg attach --workspace …` again.
- **When your `smurg` and the host's are different versions**, `smurg attach` cannot connect, and it says which side
  has to do something. It asks smurg's download site which version is the newest. When a newer one than yours is
  published: "a newer smurg (0.5.1) is published: update this one (smurg update), then connect again." When yours is
  the newest: "The host's smurg is older than this one", and it is the host who stops sharing, runs `smurg update`
  and shares again. When it cannot ask, it names both steps, yours first:
  "This smurg and the host's smurg are different versions and cannot connect. First run smurg update here. If it says this is the latest version, the host's smurg is the older one: the host stops sharing, runs smurg update and shares again."
  `smurg update` keeps this computer's device key and the workspaces you joined: you need no new invite link
  afterwards.

After joining:

```sh
smurg attach                  # lists the terminal sessions (number, owner, state), then the agent sessions with topic and status
smurg attach 2                # attaches terminal session 2 to this terminal; Ctrl-] detaches (the session keeps running)
```

Under the terminals, the list shows the agent sessions ("Agent sessions (conversations):") with their status and
topic, and the address where they open in the browser. Naming an agent session to `smurg attach` only prints that
it is a conversation, not a terminal.

The host and members with agent access can type into any terminal session; other roles can only watch (smurg says
"Read-only: …" first). When the host goes offline, `smurg attach` tells you within seconds. To protect your
terminal, a session's output is filtered before it is shown: terminal queries, clipboard access (OSC 52) and other
control sequences smurg does not know are never sent to your terminal (a program in someone else's session could
be tricked into printing them).

The CLI cannot open sessions, message agents, vote or send suggestions, and it has no "Leave": use the web app for
those.
