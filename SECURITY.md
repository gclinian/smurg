# Security policy

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting:
<https://github.com/gclinian/smurg/security/advisories/new> ("Security" tab → "Report a vulnerability").
Do not open a public issue for a vulnerability.

Say what you found, how to reproduce it, and which version (`smurg --version`) or commit it affects. You will get an
answer in the advisory thread. Fixes are released as a new version; only the latest release is supported.

## What is in scope

- **End-to-end encryption.** Everything a workspace exchanges (files, conversations with agents, terminal output,
  edits, votes, suggestions) is encrypted between the host's daemon and each member's browser or CLI; the relay
  forwards ciphertext. A way for the relay, or anyone on the network, to read or change that content is a
  vulnerability. So is a way to join a workspace without a valid invite, or to keep access after the host removed it.
- **Roles.** A member doing something their role does not allow is a vulnerability: a viewer editing or voting; an
  editor starting a topic, messaging an agent directly, answering a permission request, opening or typing into a
  terminal; a member reading files the host keeps private; anyone escaping the shared folder; anyone but the host
  merging, confirming the folder's Claude Code settings, allowing a request marked host-only, or changing a file
  only the host may change (also by renaming or deleting a folder that holds one).
- **What reaches an agent.** Text written by a member without agent access reaching an agent in any way other than
  the ones the design allows (an accepted suggestion, a submitted answer, and the files of the project that the
  agent reads: S1 to S4 and S21 below) is a vulnerability. So is text that passes for smurg's own voice towards an
  agent, a way around the cleaning of invisible characters, and a file that reaches an agent through a message
  instead of through one of its tools (S12).
- **What smurg promises about an agent's limits.** smurg's own check runs before every tool call of an agent (the
  tool gate, `docs/ARCHITECTURE.md` §7.6, §7.7). A discussion agent that runs a command, reads outside the project
  or writes anything but its topic's spec and plan; a work item's agent that edits the spec or the plan; any agent
  that writes Claude Code's own configuration or starts a subagent; an agent's shell command that writes where a
  script of the confirmed project settings is without a person having been asked; a command that runs while the
  daemon is not reachable: each is a vulnerability, whatever the host's Claude Code settings allow.
- **The relay and the web app** (`apps/relay`, `apps/web`): login, sessions, the device-code login, cross-site
  attacks, anything that lets one account act as another, and anything that lets text written by an agent or a
  member run as code in another member's browser.
- **The installer and the update** (`scripts/install.sh`, `smurg update`): installing anything other than the
  sha256-verified executable of the release.

## What is by design

- **Agent and terminal sessions run as the host.** They run on the host's computer, under the host's account, with
  the host's Claude Code login and no sandbox. A member with the role "Agent access" can open a terminal and can
  allow whatever an agent asks to run, so they can do there whatever the host can. Hosts give that role only to
  people they fully trust (`docs/HOSTING.md` §5.1). This is not a vulnerability.
- **A command that someone allowed can do anything the host's account can.** The limits above are about what an
  agent does by itself and about who may allow what. "Only the host can allow this" is a label for requests smurg
  recognizes as reaching beyond the project, not a boundary.
- **The host's own Claude Code allow rules apply to agent sessions**: what they allow runs without a permission
  request, as in the host's own terminal (the one exception is a command that could change a script of the
  project's settings, S10). The host is told once which rules apply (`docs/HOSTING.md` §5.3).
- **Every member reads every conversation**, including members who join later, and whatever an agent reads it may
  repeat to all of them. Masking of well-known credential formats is best effort (`docs/HOSTING.md` §4, §5.4).
- **Prompt injection is not solved.** Agents read the spec, the plan and the repository, and text there can ask an
  agent to do things. What stands in the way is the tool gate, a person reading each command, the confirmation at
  Start and the reviewed merge. With "always allow" for a test command, an agent that edits the tests can run what
  it wrote; the card says so.
- **The check of shell commands near a project's hook scripts reads what a command names** (S10). A program that
  names none of those scripts (a build, a script of the project that rewrites another) is not seen before it runs:
  it asks like any other command unless someone always allowed its kind, and smurg notices the changed script only
  afterwards (it then stops the folder's agents and asks the host again). What a script runs in turn is not
  followed. Hosts are told to keep hook scripts in `.claude/hooks/` (`docs/HOSTING.md` §5.3).
- **Removing an entry of a conversation is best effort.** It removes that entry. Questions, permission requests
  and suggestions are kept as cards beside the conversation and stay, and so do inbox excerpts and the audit log;
  deleting the topic removes all of these but the audit log (`docs/HOSTING.md` §5.4).
- **What the relay operator sees**: account identities, IP addresses, workspace ids, frame sizes and timing, never
  content (`docs/ARCHITECTURE.md` §6, §11 D-5). Hosts who do not accept that can run their own relay
  (`apps/relay/README.md`).
- The published checksums (`SHA256SUMS`) are served from the same place as the executables and are not signed: they
  catch a corrupted download, not a compromised publisher (`docs/RELEASING.md` §9).
- **Verification used no real model.** The topics flow was tested with a scripted stand-in for the model, and real
  Claude Code 2.1.288 only against a fake API, never against the real model, on macOS; real Claude Code was not run
  on Linux. The properties below are properties of smurg's code and of Claude Code 2.1.288 as verified that way; a
  real model's behaviour inside those limits is not verified.

## The security points of the topics flow (0.5.0)

Since 0.5.0 agents take input from several people and work with less supervision. The rule of the design: what smurg
promises, smurg's own code enforces; Claude Code's permission system is the second layer. Each point in short; the
tests that pin them are named in `docs/ACCEPTANCE.md`.

| # | Point | What smurg does |
|---|---|---|
| S1 | An Editor's suggestion steers an agent | It reaches the agent only when a member with agent access accepts it. What that member sees is what is sent: the card shows the stored text character for character, never as formatted text; invisible characters were removed and header-like lines quoted when it was stored; and it arrives under a header naming its author and who accepted. |
| S2 | Vote comments and own-word answers steer an agent | The daemon never forwards them. The agent gets the chosen options and the counts. An answer or a note in someone's own words needs agent access, and is audited with its author; a voter is named as its author only when the text is that voter's own. |
| S3 | Spec and plan text written by an Editor is read by agents | By design people edit these files. Work items start only from the content a member with agent access confirmed at Start: the dialog shows who edited by hand (a member who renamed or deleted the topic's folder is named for both files), the files are pinned by hash, and an item whose files changed since does not start. The checkpoint commit holds exactly the two files. |
| S4 | Injection through code, web pages or tool output | The tool gate decides every tool call by the kind of session, before Claude Code's permission flow and whatever allow rules exist: a discussion agent has no shell and no network tool, reads only inside the project and writes only its topic's spec and plan. A work item's edits stay in its worktree and are reviewed; commands and network ask. No agent starts a subagent (S15). |
| S5 | Who can cause a command to run on the host | A member with agent access allowing a request; a kind such a member chose to always allow (one of two checked forms, never a shell, an interpreter, something that downloads and runs code or a command made of several; removed with the member who added it; a topic's kind answers a waiting request by itself only when that request is one plain command of the kind); read-only and simple file commands inside a worktree; and what the host's own Claude Code allow rules allow, which apply to agent sessions (the host is told once which). Never an Editor or a Viewer; never a discussion session. In a folder whose confirmed project settings run scripts, a shell command that writes where such a script is, or that smurg cannot follow, asks a person whatever would have let it run (S10). Every command that ran without a request and ended without an error is in the audit log, marked as not asked; a command a topic's always-allowed kind answered is audited with that kind. |
| S6 | Permission answers | A card exists only for a request that arrived on that session's own pipe, and only open requests are answered. A person never allows what they cannot see: the whole command, an edit's diff, the address of a fetch, any other tool's whole input, as the tool will run it. Nothing is shortened, masked or removed; a character nobody can see is written out; a request too large to show is denied; and in the web app the buttons that allow wait until a long command or diff was scrolled to its end. The first answer wins. No agent writes Claude Code's configuration. Every decision of a person is audited with the full command; an answer smurg gives by itself (a topic's always-allowed kind, a refusal) with the tool and the reason. |
| S7 | What Viewers and Editors see | Every conversation, including earlier ones for a member who joins later (the invite dialog says so). Not stored and not sent: the content of files an agent reads and the lines its searches match. Of a file on a host-private path only the name is shown, never its content, also not as the old and new text of an edit that waits for permission. Of a file outside the project nothing is shown to members; a permission request for one shows its path to the host alone. |
| S8 | Secrets in what agents print | One masking function runs over what agents and their tools print before it is stored or sent: agent text, command output, diffs, reports, what an agent tells one member (well-known key prefixes, private key blocks, authorization headers, values after `password=` and similar). Not masked, so that a person sees exactly what they answer: the command an agent wants to run and the questions it asks. Agents are denied the host-private file names by rule. The host can remove one entry of a conversation; cards, inbox excerpts and the audit log keep their own copy. Best effort: see "by design". |
| S9 | Conversations on disk | In the host's state folder, readable only by the host's account, outside the shared folder and unreachable through any file request. Removed with their topic, by redaction and by `smurg uninstall`. |
| S10 | Project-level Claude Code settings run code with no trust question | Structured sessions never show Claude Code's trust dialog, so smurg has its own: a folder's settings (the three settings files and everything else below `.claude/`) are loaded only after the host confirmed exactly that content. The review lists every command, rule and environment variable and the scripts the commands name, and says when its lists do not show everything (then the host ticks that they read the files themselves); settings smurg cannot vouch for are never used. While a content is in use, only the host changes those files and scripts through smurg, and a change parks the sessions of that folder. An agent's shell command there is read before it runs: one that writes where a script is, or that smurg cannot follow, asks a person, above every allow rule. `CLAUDE.md` files are host-only for writes through smurg. The limit: see "by design". |
| S11 | A session reaches the host's other Claude Code sessions | Cross-session messaging is refused in every session's settings, and the tools for it are in no tool list. |
| S12 | A message runs a Claude Code command, or hands the model a file | Every person's text is sent under a header line, so none starts with `/`. Every message is marked as composed by a program, so Claude Code expands no `@path` in it: a file reaches an agent only through a tool call, where the gate and the permission requests apply. |
| S13 | Flooding by a low role | Caps on pending suggestions, comments, votes, mentions and inbox items; rate limits per member and per agent (editing a suggestion counts like sending one); votes and comments travel as small changes. A member's accepted requests of one kind are recorded in the audit log up to 120 a minute and the rest in a file beside it, so a loop cannot push role changes and decisions out of the log. A message with characters nobody sees cannot break the session list: a session's title is taken from the cleaned text. |
| S14 | Agent text rendered in every browser | Markdown is rendered to elements, never as HTML; link schemes are limited; images are not loaded; a link whose words name another place shows where it leads; nothing of a text is hidden, and a text too long or too deeply nested to format is shown as it was written instead of freezing the page. Agent text loses invisible, direction-changing and control characters before it is stored; colour codes are removed from command output, and a permission card shows hidden characters as visible marks. The content security policy is unchanged. |
| S15 | Claude Code changes while the web build is strict | Only smurg's own event shapes travel; every string is clipped to a limit; unknown lines are ignored. The tool set is an explicit list per kind of session, so a tool a future Claude Code adds does nothing until a smurg release lists it. No list holds the tool that starts subagents: a subagent works with the permission mode of its own definition, not the session's. Claude Code 2.1.288 is the floor. |
| S16 | The daemon dies while agents run | The gate fails closed: an orphaned agent's next tool call is refused, whatever rule would have allowed it. What is left is ended at the next start, and the conversation says the agent may have gone on for a moment. Nothing continues by itself. |
| S17 | A member leaves or is removed and their sessions pass to the host | A handover never raises what the session's agent may edit. What the member put in place goes with them: the kinds they always allowed, the items they started that have not begun, a mode they loosened, their queued messages, their votes. A removed member's topic sessions are stopped first. The worktrees a removed or demoted member had kept pass to the host, and removing a worktree needs agent access each time. |
| S18 | The host's Claude account is used by others | A fact of the design. The New topic dialog says whose account the agent uses and tells the host that a personal subscription is for their own use; the host console's security notes and the host guide say the same and what fits a group; and the host is told once per workspace when a Pro or Max login is used and the workspace has other members. Nothing is blocked. |
| S19 | The control socket | Unchanged and minimal: status, stop, and what `smurg attach` needs (listing sessions, attaching to a terminal and typing into it). None of the new requests (messages to agents, votes, permission answers, topics, reviews, trust decisions) is reachable through it. |
| S20 | Text under smurg's own voice | What smurg tells an agent holds only fixed sentences and values checked by pattern, under a tag that is random per session; nothing copied from a title, a summary or a file, and people are named in a restricted alphabet. One message repeats earlier text: a restarted discussion gets the team's earlier decisions as one block marked as a quotation. |
| S21 | People writing into an agent's worktree | People may edit code there, and the report names the files and the people. Nobody can write the topic's folder there: not the spec copy the agent started from, not the report, and not by renaming or deleting a folder above them. A report counts only after the agent's own check passed for that content in that session. |
| S22 | The host's own MCP servers, connectors and plugins | Not offered to agent sessions unless the host switches them on; never to a discussion session. |
| S23 | What the audit log shows | Every command that ran without a person's decision (marked as not asked, or with the always-allowed kind that answered it), every message smurg sent by itself, starts and refusals of the scheduler, the creation of every session (with its mode and the state of the project settings for a session without a topic), and for a submitted own-word answer its author. Role changes, removals, decisions about project settings and removed entries are never moved to the overflow file of S13. |
