# smurg v0.5.0: the interface (UX)

Companion to `OWNER-BRIEF.md` (the owner's flow and the twelve decisions, D1–D12 below). This document says how the
interface behaves; the mock shows it.

- Mock: `mock/index.html` (static HTML + CSS + a little vanilla JS, on the app's real style sheets: `mock/app-*.css`
  are unchanged copies of `tokens.css`, `base.css`, `components.css`, `app.css`, `files.css`, `editor.css`; everything
  new is in `mock/mock.css`, one class prefix per future feature folder).
- Screenshots: `shots/` (1440 × 900 unless the name says 1024; taken with the repository's headless system Chrome).
- Checked by clicking: `smoke.mjs` drives the mock in headless Chrome, 41 checks, all pass (`smoke-result.txt`) (columns, dividers, votes,
  ties, submit, permission answers, inbox, keyboard, 1024 px). What is NOT mocked is listed in §16.
- Sample workspace: "bookshop". Ian = Host (the viewer of most pages), Mei and Ken = Agent access, Amy = Editor,
  Leo = Viewer.

Contents: 1 layout · 2 columns · 3 left column · 4 conversation · 5 cards · 6 topic lifecycle · 7 inbox · 8 code mode ·
9 small windows · 10 roles · 11 keyboard and focus · 12 empty states · 13 errors and odd states · 14 what the interface
needs from the daemon · 15 glossary additions · 16 limits of the mock · 17 decisions taken without asking ·
18 open questions (multiple choice).

---

## 1. Layout

`shots/01-main.png`, `01-main-light.png`, `01-main-zh-TW.png`

```
┌ top bar ─ smurg │ workspace · host · connection │ people · my role │ console │ [Sessions|Code mode] │ ◧ 🌐 ☾ Leave ┐
├ left column (288 px) ┬ column ───────┬ column ───────┬ column ───────────────────────────────────────────────────┤
│ Inbox            (6) │ a session's   │ the plan      │ a result report                                           │
│  agents are waiting  │ conversation  │               │                                                           │
│  for you to look at  │               │               │                                                           │
│ Sessions  [New topic]│               │               │                                                           │
│  ▾ topic             │               │               │                                                           │
│     Spec / Plan      │               │               │                                                           │
│     sessions …       │ composer      │               │ follow-up · I've reviewed this                            │
└──────────────────────┴───────────────┴───────────────┴───────────────────────────────────────────────────────────┘
```

**Top bar** (the existing one, `app-topbar`): unchanged are the wordmark, workspace name, "Host: name", the connection
pill, the avatars of online members, my role, "Host console" (host), language, theme, "Leave". New:

- The **mode switch** at the right: two segments, "Sessions" and "Code mode" (D11). It is a pressed-button pair
  (`aria-pressed`), not a route change: both sides keep their state. In code mode the "Sessions" segment carries the
  inbox count, so a question is not missed while hand-coding.
- One layout toggle in the sessions view (show or hide the left column); the three panel toggles of today's workbench
  exist in code mode only.

**Left column**: Inbox above Sessions, both collapsible (D8). 288 px by default, 220–420 px by its divider, or
collapsed to a 44 px rail (inbox icon with its count, sessions, new topic).

**Right side**: up to four columns side by side with draggable dividers (D7). A column is a session's conversation, a
spec, a plan or a result report (D5 of the owner's flow: plan and result understanding are shown on the right).

Landmarks: `banner` (top bar), `complementary` "Inbox and sessions", `main` "Open columns"; each column is a `region`
named by its title, with the title as its `h2`; every card inside is a `section` with an `h3`.

---

## 2. Columns

`shots/01-main.png`, `03-topic-6-execution.png`, `04-inbox.png`; states of the right side: `01-main-empty.png`

| Rule | Behaviour |
|---|---|
| How many | At most 4. A thing (a session, a spec, a plan, a report) is open at most once. |
| The focused column | The column last clicked or tabbed into. Marked by the accent line on top of its header. It is where a click on the left opens, and next to which "open to the side" adds. |
| Click a row or an inbox item (Enter) | Opens it in the focused column, replacing what that column showed. If it is already open in another column, that column gets the focus instead. With nothing open it becomes the first column. Replacing loses nothing: an unsent text in a composer is kept per session. |
| Open to the side | The button that appears on a row on hover or focus (`shots/04-inbox-collapsed.png`, row "2 · Payment form"), Shift+click, Shift+Enter, the row's context menu. Buttons inside a column that lead elsewhere ("Open spec", "Open plan", "Session", "Report", "Open the session") always open to the side, so the column one is reading stays. The new column is placed right of the focused one and gets the focus. |
| A fifth column | Refused, with the message "Four columns are open. Close one first." (see Q8). |
| Close | The × of the column header; Delete on the column's title. Focus moves to the right neighbour, else the left one; after the last column the empty state shows and focus goes to the session list. Closing never ends a session. |
| Widths | A divider trades width between its two neighbours; no column goes below 320 px. Arrow keys move it 16 px (Shift: 64 px), a double click makes all columns equal. Widths, the open columns and their order are remembered per browser and workspace (like today's `smurg.layout`). |
| Wide columns | With one or two columns open, the content keeps a readable measure (800 px) in the middle of the column (`shots/03-topic-2-discussion.png`). |
| Do not fit | See §9: whole columns only, the rest is reached sideways. |
| Per person | Columns are each person's own view. Nothing about them is sent to the host or to other members. |

A column's header: an icon (a session: its status glyph), the title, the topic's name, "More actions" (⋯: close the
other columns; for a session also rename, details, end), close.

---

## 3. Left column

### 3.1 Inbox

`shots/01-main.png` (six kinds), `04-inbox.png`, `04-inbox-collapsed.png`, `04-inbox-viewer.png`

- Header: a twisty, "Inbox", the count. Collapsed, the header and the count stay.
- The list is as tall as its items, up to 46 % of the column; beyond that it scrolls by itself (the session list
  keeps the rest).
- Two groups, in this order: **Agents are waiting** (questions and permission requests: an agent does nothing until
  someone acts; oldest first) and **For you to look at** (suggestions, result reports, merge requests, mentions;
  newest first).
- A row: the kind's icon (a tinted square; six kinds, `shots/02-states-1.png`), a first line (the question, the
  command in monospace, "Amy: …", "Result report: …", "Mei asks to merge …", "Ken mentioned you: …"), a second line
  (topic › session, and a fact such as "3 of 4 voted"), the age. Unread (never opened): bold with a dot.
- The row whose target is shown in the focused column is selected.
- What each kind opens, who gets it and how it leaves: §7.
- The count is also on the rail, on the "Sessions" segment while in code mode, and in the browser tab's title.

### 3.2 Sessions, grouped by topic

- Header: a twisty, "Sessions", **New topic**.
- A topic is a collapsible group: twisty, name, its phase as a badge (Discussing → Spec → Plan → Executing →
  Complete), "More actions" on hover or focus (rename, watch its running sessions side by side, archive).
- Inside a topic, in this order: **Spec** (when the file exists; "draft" until a plan exists), **Plan** (with
  "n of m reviewed"), the **Discussion** session, then one session per started work item in plan order
  ("1 · Cart API"), then other sessions of the topic, then **New session**.
- A session row: status glyph, title, the responsible person's avatar (or the "everyone watches" icon), and, when the
  item has one, a small result-report button (green while it waits for review, grey after).
- Sessions that belong to no topic are in the group "No topic" (see Q3). A plain terminal has the terminal icon
  instead of a status glyph.
- A complete topic collapses by itself and sinks below the others; archived topics leave the list ("Show archived
  topics" at its end).
- Open in a column: a bar at the row's left edge. Shown in the focused column: the selection fill as well. A bold
  title: something happened there since I last had it in a visible column.

Status of a session (shape and colour, never colour alone; `shots/02-states-1.png`):

| Status | Glyph | Meaning |
|---|---|---|
| Running | blue arc (turning; still with reduced motion) | The agent is working. |
| Waiting for an answer | amber circle with "?" | A question card is open. |
| Waiting for permission | amber shield with "!" | A permission card is open. |
| Idle | grey hollow circle | The agent finished its turn and waits for a message. Added to the five the task named: a discussion session is in this state most of the time. |
| Done | green circle with a check | The work item is finished and its result report is written. |
| Failed | red circle with a cross | The agent gave up or its process ended with an error. |
| Ended | grey square | Ended on purpose (not a work item's success or failure). |
| Waiting for another item / Not started | clock / dashed circle | Plan items only (no session yet). |

Amber always means "a person must act". When several apply to one session the most urgent shows: failed, waiting for
permission, waiting for an answer, running, idle. (Today's tab dot is green for "running"; green now means "done".)

---

## 4. A conversation column

`shots/02-conversation-host.png`, `02-conversation-editor.png`, `02-conversation-viewer.png`, sheet
`02-states.png` (+ `02-states-1..7.png`, one per section)

**Header strip** under the column header, left to right:

- **Responsible** ("Responsible: Ian (you)", or "Everyone watches"): for the host and members with agent access a
  menu to change it (the people present with their role and how many items they have, and "No one: everyone watches").
- **Where it works**: the worktree's branch, or "Main workspace". A click opens code mode on that root (§8).
- **Permission mode**: "Asks before commands" for execution sessions (D9); a menu for the host and members with agent
  access: "Asks before commands" (default), "Asks before edits and commands", "Asks for nothing" (with a warning
  line), and the list of kinds that are always allowed in this session, each removable. The discussion session shows
  a lock and "Reads code, writes only the spec and plan": fixed (D9).
- **Watching now**: the avatars of members who have this session in a visible column.
- At the right: **Stop** (only while the agent works: ends its current turn, the session stays) and **End** (ends
  the session, after the existing confirmation about the worktree).
- Below 620 px of column width the worktree and the permission mode show as icons (text in the tooltip and the
  accessible name); below 430 px "watching" and the topic's name in the header go too.

**The conversation**, oldest first:

| Piece | Look and rule |
|---|---|
| A person's message | Avatar, name, role, time, the text in a bubble (my own: accent tint). A message that came from a suggestion says "suggestion, accepted by Ian" after the time. |
| The agent's text | "Claude" with the agent avatar and time, then prose without a bubble. While it streams, a caret ends the text and the bar above the composer says "Claude is writing · 48 s". |
| Tool actions | One compact line each (native `<details>`): icon, verb ("Read", "Edited", "Created", "Ran", "Searched"), target in monospace, result at the right ("+38 −6", "14 passed · 9 s", "exit 1 · 11 s" in red). Expanding shows the diff or the output; a file action has **Open in editor** (§8). A run of file reads is one line ("Read 4 files in src/cart") that expands to the list. A running command shows "Running …" with the elapsed time. |
| A system line | A centred hairline with text: "Started from plan item 1 · worktree smurg/ian/cart-api · 13:41", "Ian asked for the plan · 14:20". |
| Cards | Question, permission request, suggestion (§5); a pointer card to a spec, a plan or a result report with its "Open" button. |

Scrolling: the conversation follows new content only while it is at its end; otherwise a "New activity" button
appears at the bottom edge. The bar above the composer always says what the session waits for; clicking it scrolls
to the open card.

**The bar above the composer** (`role="status"`): "Claude is writing · 48 s" / "Claude is waiting for an answer ·
6 min" (amber) / "Claude is waiting for permission · 40 s" (amber) / "Claude is idle." / "Done. Claude answers
follow-ups here and in the report."

**The composer follows the role** (`shots/02-states-6.png`):

| Viewer of the column | Composer |
|---|---|
| Host, Agent access | "Message Claude", a send button. Enter sends, Shift+Enter makes a new line. While the agent works: "Claude reads it at its next step". |
| Editor | The same box says "Suggest something to Claude" and has the button "Send suggestion"; the line under it says where it goes: "Goes to Ian as a suggestion. It reaches the agent only when accepted." (D3) |
| Viewer | No box. One line: "As a viewer you can watch this session. You cannot send messages, make suggestions or vote." |
| Anyone, session ended | "This session has ended. It takes no more messages." |
| Anyone, host offline | The box is disabled; the existing "Host offline" banner says why. |

Enter never sends while an input method is composing (`event.isComposing`): Chinese is typed with Enter. A text that
could not be sent stays in the box with one line under it saying why. Unsent text is kept per session in this
browser.

---

## 5. Cards that wait for people

### 5.1 Question (D2)

`shots/02-states-2.png` (eight states), `01-main.png`, `03-topic-2-discussion.png`

- Head: "Question from Claude", and "3 of 4 voted" (the members who may vote: everyone but Viewers).
- The question, then its options as one radio group "Your vote": label, the agent's description, at the right the
  avatars of those who chose it and their number; a fill behind the option shows its share. The option with strictly
  the most votes carries "Leading".
- **Other**: the last option. Choosing it shows a text box; every "Other" text is listed under the option with its
  author. An "Other" vote needs a text.
- Votes are live for everyone and can be changed until the answer is submitted.
- **Comments**: a thread under the options (open when there are few). Everyone but Viewers writes; "@name" mentions
  a member (§7).
- Footer, by who looks:

| Viewer of the card | Footer |
|---|---|
| The decider: the responsible person; when nobody is assigned, the person who opened the session | "You decide: you are responsible for this session." (or "… nobody is assigned to this session, and you opened it."), **Answer to submit** (a select prefilled with the leading option) and **Submit answer**. |
| …with a tie | Nothing prefilled, "The vote is tied. Choose the answer yourself.", Submit disabled until an answer is chosen. |
| …with no votes | Nothing prefilled, "Nobody has voted yet. You can still choose and submit." |
| Another member who may vote | "Ian decides (responsible for this session). Your vote and comments are visible to everyone." |
| Viewer | No radio buttons, no comment box: "You are watching. Viewers do not vote. Ian decides." |

- The decider may submit at any time, also against the vote: the vote advises, the decider decides (D2). If "Other"
  is submitted, the select lists each "Other" text with its author and the decider may edit the text before sending.
- Several questions in one request of the agent are one card: the questions stacked, each with its own votes and its
  own "Answer to submit", one "Submit answers" that is enabled when each has an answer. A question that allows
  several options uses checkboxes; prefilled are the options chosen by at least half of those who voted.
- After submitting, the card folds to one line for everyone: the question, the answer, "2 votes to 1", who submitted
  and when; it can be expanded (read-only). Withdrawn (the session was stopped or ended first): "Not answered: the
  session was stopped by Ian at 13:53".
- The decider is offline: the footer says so, and the host and members with agent access get "Take over" (it makes
  them the responsible person, see Q2).

### 5.2 Permission request (D8, D9)

`shots/02-states-3.png`, `02-conversation-host.png` (middle column)

- Head: "Claude asks for permission to run a command" and how long it has waited.
- The exact command in a monospace block (wrapped, never shortened; more than eight lines scroll inside the block),
  the worktree it runs in, and the agent's reason when it gave one. Requests that are not commands (a network
  address, a file outside the worktree) use the same card with their own head line.
- Who may answer: the host and every member with agent access, whoever is responsible. Buttons: **Allow once**,
  **Always allow this kind**, **Deny**. Under them, in words, what "this kind" is ("commands that start with
  `pnpm add`, in this session only") and whose inbox the request is in.
- Deny opens one optional line, "What should Claude do instead?"; the agent reads it.
- Editors and Viewers see the command and "Waiting for Mei (responsible), the host or a member with agent access.
  Your role cannot allow commands."
- The first answer wins; everyone else's card settles at once to "Allowed once by Mei, 13:55" / "Allowed, and always
  for `pnpm add` in this session, by Mei" / "Denied by Mei: …".
- Opening a column at a permission card puts the focus on the card, never on a button (an Enter typed too early must
  not allow a command).

### 5.3 Suggestion (D3)

`shots/02-states-4.png`, `04-inbox.png`

- An Editor's message is a card in the conversation at the time it was sent: "Suggestion from Amy", the text.
- The host and members with agent access: **Accept**, **Edit and accept**, **Reject** (with an optional reason), and
  "It reaches the agent only when someone accepts it."
- Its author: **Edit**, **Withdraw**, and who it waits for. Everyone else: who it waits for.
- Accepted: the card becomes a message of its author marked "suggestion, accepted by Ian" (or "edited and accepted"),
  and the agent gets it. Rejected or withdrawn: one line that stays ("Rejected by Ian: …").
- The rules of today's suggestions stay (the accept sends the text on screen; a session that ends closes its pending
  suggestions with the reason).

---

## 6. A topic from start to finish (D4, D5, D6, D10)

| Step | Screen | What happens |
|---|---|---|
| New topic | `03-topic-1-new.png` | Host or Agent access. Name, "What do you want to build?" (optional, becomes the first message), the folder `specs/<name>/`. It says that this opens an agent on the host's computer with the host's Claude account, which may read the code and write only that folder. "Start discussion" creates the topic and its discussion session, opens it as a column. |
| Discussion | `03-topic-2-discussion.png` | One shared session per topic. Everyone talks (Editors through suggestions); the agent asks its questions one at a time as cards; everyone votes; the person who opened it submits (nobody is assigned to a discussion). Answered questions fold to a line, so the decisions read as a list. |
| Spec, first draft | `03-topic-3-spec.png` | The agent writes `specs/<topic>/SPEC.md` and puts a pointer card with "Open spec" in the conversation. The topic's phase becomes "Spec" and the row "Spec" appears. |
| Spec column | `03-topic-3-spec.png`, `03-topic-4-spec-edit.png`, `03-topic-5-plan.png` | Toolbar: **Read / Edit**, the file's path, **Ask the agent to revise**, **Generate plan**. Read: the rendered Markdown; each section has two actions on hover or focus (ask the agent to revise this section, comment); sections the agent changed since I last looked are tinted, with "Changed by Claude at 14:05, asked by Mei · Show the change". Edit: the existing collaborative editor on the file (cursors and selections of the others, "2 editing"). Viewers read. While the agent writes the file, the editor is read-only for the moment with the existing banner. |
| Ask the agent to revise | `03-topic-3-spec.png` (bottom of the spec column) | A box opens at the bottom of the spec column: an optional quoted section, "What should the agent change?". It goes to the topic's discussion session as a message (an Editor's: as a suggestion), where everyone sees it; the agent edits the file, and may ask a new question first. This is "repeating the flow" of the owner's step 1. |
| Generate plan | `03-topic-5-plan.png` | Host or Agent access. The agent reads the spec, writes `PLAN.md`, says so in the discussion with "Open plan". Later the button reads "Update plan"; a plan older than the spec says "The spec changed after this plan was written." |
| Plan column, before the start | `03-topic-5-plan.png`, `03-topic-5-plan-everyone.png` | **Items / File** (the file is the same collaborative editor). "6 work items · 5 can start now · 1 waits for others". **Who watches what**: "Assigned people" or "Everyone watches". With assigned people: the agent's suggestion for the people present ("Ian 2 · Mei 2 · Ken 2"), and on every item a chip "Mei · suggested" that opens the menu to change it. With "Everyone watches": no chips; questions and permission requests go to the person who presses Start. Each item: number, title, description, "after 1 and 2", its state ("Ready to start", "Waits for 1 and 2"), "Start this one". Footer: **Start 5 items**, and what that does (one agent session per item, each in its own worktree). |
| Execution | `01-main.png`, `03-topic-6-execution.png` | Each started item is a session in the topic's group. The plan stays the overview: a progress bar (one segment per item), "0 of 6 reviewed · 1 report to review · 2 wait for a person · …", and per item its state as a badge ("Running", "Waiting for an answer", "Waiting for permission", "Report to review", "Failed", "Waits for 1 and 2") with the links "Session", "Report", "Try again". "Watch running sessions side by side" opens them as columns (up to four). |
| Result report | `03-topic-7-report.png` | When an item is done the agent writes its result report; the session says so with "Open report", the row gets the report button, the responsible person gets an inbox item. Sections, always these: **What was done**, **Why it was done this way**, **How it was verified** (each check passed or "Not verified: …"), **What to watch out for** (set off in amber), **Changes** (files with +/−, each expandable to its diff, "Open in editor"), **Follow-ups**. At the bottom: "Ask a follow-up about this result" (goes to the item's session; the answer appears in both places) and **I've reviewed this**. |
| Reviewing | `03-topic-7-report.png`, `03-topic-8-complete.png` | "I've reviewed this" is for the item's responsible person (nobody assigned: any member but a Viewer). Others read: "Ian is responsible for this item and reviews this report." After it: "Reviewed by Ian, 14:31", and the host gets "Merge…" (the existing diff review), a member with agent access "Request merge". A report the agent changes after the review says "Changed after the review" and returns to the reviewer's inbox. |
| Topic complete | `03-topic-8-complete.png` | Every item reviewed (D6): the phase is "Complete", the plan shows "Topic complete" with what is still open ("1 merge request waits for the host") and "Archive topic". |

A failed item (`shots/02-states-5.png` third cell, the session "5 · Seed data script" in the mock): the session ends
with a red banner "This work item failed" and what is kept; the agent's last text says what it could not do and what
it would need; the plan item says "Failed" with "Try again" (a new session in the same worktree).

---

## 7. Inbox items: what opens, and how an item leaves

`shots/04-inbox.png`: the suggestion was clicked; the session opened in the focused column, scrolled to the card,
which is outlined for two seconds; the report was opened to the side.

| Kind | In whose inbox | A click opens | It leaves when |
|---|---|---|---|
| Question | The session's decider (the responsible person; nobody assigned: the person who opened it) | The session, scrolled to the card; focus on the card | Someone submits the answer; the question is withdrawn; another person becomes responsible (it moves) |
| Permission request | The responsible person when they may answer; otherwise the host and every member with agent access | The session, scrolled to the card; focus on the card, not on a button | Anyone who may answer does; the agent's request is cancelled |
| Suggestion | As a permission request | The session, scrolled to the suggestion | Accepted, rejected, withdrawn, or closed with the session |
| Report to review | The item's responsible person (nobody assigned: the person who pressed Start) | The result report | "I've reviewed this" is pressed; the item is reassigned |
| Merge request | The host | The result report of that item at "Changes", with Merge and Reject (a worktree without a report: the same column with only "Changes") | Merged or rejected; a conflict keeps it, marked "Conflict" |
| Mention | The mentioned member, whatever their role | The column that holds the comment, scrolled to it | It is opened, or dismissed with its × |

- An item is a thing that waits, not a message: it leaves when the thing is settled, by whoever settles it, in every
  inbox at the same moment. There is no "archive" and no "mark as done" for the five kinds that wait for an action
  (a hidden item would leave an agent waiting). Looking at an item only removes "unread".
- If someone else settles what I have open, my card settles in place and says who did it.
- Changing a session's responsible person moves its items to the new person's inbox.
- A decision on my own suggestion is not an inbox item: it is a toast, as today, and the card's new state.
- A new item in "Agents are waiting" whose session is not in a visible column also shows a toast with "Open".
- By role: the host can get all six kinds; a member with agent access all but merge requests; an Editor mentions
  (and more, depending on Q1); a Viewer mentions only (`shots/04-inbox-viewer.png`: "Nothing is waiting for you. As a
  viewer you get only mentions here.").

---

## 8. Code mode (D11)

`shots/05-code-mode.png`

Today's workbench, behind the switch: the file tree with the root selector (main workspace, each worktree), the
editor (Monaco + Yjs, tabs, lock banner), the bottom drawer. Changes to it:

| Today | v0.5.0 |
|---|---|
| Right pane: session tabs with terminals, suggestions under them | One session column, the same component as in the sessions view, with a selector for which session; closing it gives the editor its room |
| Drawer: Activity, Conflicts, Transfers, Merge requests | Activity, Conflicts, Transfers, **Terminal** (plain terminal sessions). Merge requests are inbox items and are decided in the report column |
| Suggestions panel | Gone: suggestions are cards in the conversation and inbox items |

From a session's changed file to the editor:

1. A file action in a conversation, expanded, has **Open in editor**; so has each file under "Changes" of a result
   report; a file path in the agent's text is a link (as today); the worktree chip of a session opens the root.
2. Each switches to code mode with the root set to the session's worktree, the file open (at the changed lines when
   known), that session in the side column, and a list **Changed by this session** above the tree.
3. A line above the editor says where one came from and has **Back to the session**, which returns to the sessions
   view with its columns as they were. The "Sessions" segment does the same.

"Send to agent" from a selection in the editor (existing) puts the quoted lines into the composer of the side
column: a message for the host and members with agent access, a suggestion for an Editor.

While in code mode the inbox is one click away (the count on the "Sessions" segment) and new "agents are waiting"
items show a toast.

---

## 9. Small windows

`shots/01-main-1024.png`, `01-main-zh-TW-1024.png`, `06-small-1024-4-columns.png`,
`06-small-1024-4-columns-scrolled.png`, `06-small-1024-rail.png`, `06-1440-4-columns.png`

- A column is never narrower than 320 px. The strip shows as many **whole** columns as fit, never a cut one, and the
  rest is reached sideways.

| Window | Left column | Columns that fit | With 4 open |
|---|---|---|---|
| 1440 px | 288 px | 3 (383 px each) | 3 visible, "1 more" at the right edge |
| 1440 px, left column as a rail | 44 px | 4 (348 px each) | all visible |
| 1024 px | 248 px | 2 (387 px each) | 2 visible, "2 more" |
| 1024 px, rail | 44 px | 3 (326 px each) | 3 visible, "1 more" |

- Reaching a column that is out of view: the edge button ("2 more", scrolls by one column), its row on the left
  (which also says it is open), F6, or a trackpad swipe (the strip snaps to columns). The page itself never scrolls.
- While the strip overflows, a divider changes the width of the column before it and the rest move along.
- Below 1100 px the top bar drops "Host: name" and shows "Host console" as an icon.
- The inbox never takes more than 46 % of the left column's height; at 768 px that is four to five items, the rest
  scrolls inside it.
- Below about 900 px (not mocked): the left column becomes an overlay opened by its toggle and one column shows.
  smurg stays a desktop application; phones are not a target.

---

## 10. Roles

What each role can do in the new interface. The role labels are the existing ones.

| Action | Host | Agent access | Editor | Viewer |
|---|:-:|:-:|:-:|:-:|
| See every session, spec, plan and report; open columns | yes | yes | yes | yes |
| New topic, new session, generate plan, start work items, try again | yes | yes | no (the dialog explains) | no |
| Send a message to an agent; ask a follow-up; ask the agent to revise | yes | yes | as a suggestion | no |
| Vote, comment, mention | yes | yes | yes | no |
| Submit an answer | when decider | when decider | see Q1 | no |
| Accept or reject suggestions | yes | yes | no | no |
| Answer permission requests; change a session's permission mode | yes | yes | no | no |
| Stop the agent's current turn | yes | yes | no | no |
| End a session | any | one they opened or are responsible for | no | no |
| Change who is responsible; switch a plan to "Everyone watches" | yes | yes | no | no |
| Be the responsible person | yes | yes | see Q1 | no |
| "I've reviewed this" | when responsible, or nobody is | the same | the same (see Q1) | no |
| Edit the spec and plan files | yes | yes | yes | no |
| Merge or reject a merge request | yes | request only | no | no |
| Archive a topic | yes | yes | no | no |
| Be mentioned | yes | yes | yes | yes |

Controls a role cannot use are absent, not greyed, wherever a sentence in their place can say who can (the permission
card, the question footer, the composer). "New topic" and "New session" stay visible for Editors and Viewers and open
the explanation, as "New session" does today. The daemon enforces; the interface only hides.

---

## 11. Keyboard and focus

| Keys | Where | Does |
|---|---|---|
| F6 / Shift+F6 | anywhere | Next / previous region: inbox, session list, each column in order |
| ↑ ↓ | inbox and session list | Previous / next row (one tab stop for the list, roving) |
| → ← | a topic row | Expand / collapse |
| Enter | a row or inbox item | Open in the focused column |
| Shift+Enter (Shift+click) | a row or inbox item | Open to the side |
| Shift+F10 / the menu key | a row | Its context menu (open, open to the side, rename, change responsible, end) |
| Delete | a column's title | Close the column (the key that closes an ended tab today) |
| ← → (Shift: bigger steps), double click | a divider | Resize; equal widths |
| Tab | inside a column | Header actions, strip, the conversation (one stop; arrows scroll), each open card's controls, the composer |
| Enter / Shift+Enter | composer | Send / new line; never while an input method is composing |
| Space / arrows | a question's options | Choose my vote (a native radio group) |
| Escape | menus, dialogs, the revise box | Close; focus returns to the control that opened it |

Deliberately without a shortcut: Stop, End, Submit answer, Allow, the mode switch (see Q9 for the last one).
Ctrl/Cmd+W cannot be used by a web page, so closing a column has no such key.

Focus rules:

- Opening a column puts the focus on its title; opening it from an inbox item puts it on the card the item is about.
- Nothing that arrives by itself (a new message, a new card, a new inbox item) moves the focus or the scroll position
  of a column someone is reading. New "agents are waiting" items are announced politely (`aria-live="polite"`) with
  their kind and session.
- After Submit, Allow, Deny, Accept or Reject the focus stays on the settled card, so its result is read out.
- Closing a column: focus to the neighbour's title (right, else left), else to the session list.
- The focus ring is the app's one ring (`--focus-ring`); rows and dividers use the inset outline they use today.
- Every status and kind icon has a name ("Waiting for an answer", "Permission request"); avatars are named
  ("Responsible: Ian"); counts are in the accessible names ("Inbox: 6 items").
- Reduced motion: the running glyph and the caret stand still.

In the mock a row is a `div` holding buttons; in the app it is a `treeitem` whose extra actions are reached by the
keys above and the context menu (no nested buttons in a tree item).

---

## 12. Empty states

| Where | Text | Screen |
|---|---|---|
| A workspace without topics, right side | "Start with a topic" with the four steps (Discuss, Spec, Plan, Execute and review), "New topic", "or open a single session without a topic". Editors and Viewers: "When the host or a member with agent access starts a topic, it appears on the left." | `01-main-first-run.png` |
| Topics exist, nothing open | "Nothing is open", how clicking and "Open to the side" work, and "Waiting for you": the first inbox items with "Open" | `01-main-empty.png` |
| Inbox | "Nothing is waiting for you." (a Viewer: "… As a viewer you get only mentions here.") | `01-main-first-run.png`, `04-inbox-viewer.png` |
| Session list | "No topics yet." | `01-main-first-run.png` |
| A topic without a spec | Row "Discussion" only; the spec is offered by the agent's pointer card | `03-topic-2-discussion.png` |
| Spec column before a draft exists | "No spec yet. Discuss with the agent first; it writes the first draft." and, for the host and members with agent access, "Ask the agent to write the spec now" | not mocked |
| Plan column before a plan exists | "No plan yet. Generate it from the spec." with "Open spec" | not mocked |
| A question without votes or comments | The options with 0 and the note for the decider | `02-states-2.png` |
| A report without follow-ups | The heading is left out; the follow-up box stays | not mocked |

---

## 13. Errors and odd states

| Situation | What people see |
|---|---|
| Host offline, or reconnecting | The existing banner and pill. Everything stays readable; composers, votes and card buttons are disabled with the banner as the reason; nothing typed is lost. Votes and answers are not queued while offline. On return the lists and open columns refresh, and settled cards settle. |
| The host's Claude Code is logged out, missing or too old | "New topic", "Start" and "Try again" fail with the existing sentences; an agent session says it in the bar above its composer. Only the host can fix it; the sentence says so. |
| A session could not be started | A toast with the reason; the plan item stays "Ready to start" with "Could not start: … · Try again". |
| The agent's process ends with an error | The session is "Failed": a red banner in the conversation, open cards are withdrawn ("Not answered: the session ended"), the plan item says "Failed" with "Try again". |
| Two people answer at once | The first answer wins. The other's card settles to the real result with who gave it; their own click is dropped, with a toast only if it differed ("Mei already allowed this"). |
| A message, vote, comment or answer could not be sent | The control keeps its state, one line under it says why; nothing is retried silently. |
| The decider is offline while an agent waits | The card and the inbox item of everyone who can take over say "Ian is offline"; "Take over" (Q2). |
| The responsible person is removed from the workspace or loses the role | Their sessions' responsibility falls to the host; the items move to the host's inbox. |
| The member who opened sessions leaves or loses agent access | Today such sessions end (ARCHITECTURE D-15). With topics that would stop a running plan: see Q5. Until decided, the Leave dialog names the work items that would stop. |
| A fifth column | "Four columns are open. Close one first." |
| A column's session is no longer kept by the host | The existing sentence ("… no longer keeps its content. You can close this column."). Conversations of a topic should be kept until the topic is archived (§14). |
| SPEC.md or PLAN.md was deleted or renamed | The column turns read-only with who did it and "Create again from this content" (the existing document rule). |
| PLAN.md cannot be read as work items | The "Items" view says "smurg cannot read the work items from PLAN.md (line 14)." with "Open the file" and "Ask the agent to fix it"; "Start" is disabled. |
| The agent is writing the spec or plan | The editor is read-only for the moment, with the existing lock banner. |
| A person's text and the agent's edit overlap | The person's text is kept (existing rule); the column shows "A change by Claude overlapped with what you typed. Your text was kept." with "Review the conflict" (opens the conflicts panel in code mode). |
| The spec changed after the plan was written | The plan says so, with "Update plan". Items already started keep running; the update lists what changed. |
| The folder is not a git repository | No worktrees (existing rule). Spec and plan are plain files, "not versioned". How items then run needs a decision outside UX (one at a time in the main workspace is the cautious reading); the plan footer must say which. |
| A folder `specs/<name>` already exists | The New topic dialog says so under the folder field and keeps the dialog open. |
| My role changes while I look | The composers, cards and buttons follow the new role at once (the existing reconnect); a toast names the new role. |
| Long names, long commands | Titles are cut with an ellipsis and have the full text as tooltip and name; a command is never cut, it wraps. |

---

## 14. What the interface needs from the daemon

Stated as needs, not as a protocol (the protocol task owns the messages).

- Topics: id, name, folder, phase, archived; and which sessions, spec, plan and reports belong to one.
- Per session: topic, work item number, who opened it, who is responsible (or nobody), status including which kind
  of waiting, worktree, permission mode with its always-allowed kinds, who has it visible, title.
- A conversation as events that a late joiner can load: person messages (with "came from a suggestion, accepted by"),
  agent text as it streams, tool actions with a one-line summary and an expandable body, system lines, questions
  (text, options with descriptions, single or several, an "Other"), votes, comments, the submitted answer, permission
  requests (the command, where, the reason, the rule "always allow" would add) and their answers, suggestions and
  their decisions.
- Plan items read from PLAN.md: number, title, description, depends on, suggested and current responsible person,
  state, its session, its report, its merge state.
- A result report with fixed sections, checks with a state each, the changed files with counts and diffs, follow-ups,
  reviewed by whom and when.
- The inbox per member, computed by the daemon (the counts must be right before any column has loaded), and unread
  marks per member.
- Kept until the topic is archived: the conversations and reports of its sessions.

Assumed, not verified in this task (the session-layer task must confirm): that a structured Claude Code session
reports a question as 1–4 questions with 2–4 options each, a label and a description per option, an optional
"several answers" flag and a free-text "Other"; that a permission request carries a suggested rule for "always
allow"; and that a message sent while the agent works is read at its next step.

---

## 15. Glossary additions (for `docs/GLOSSARY.md`)

| Concept | English (UI label / prose) | zh-TW | Wire id (proposal) |
|---|---|---|---|
| A feature or task with its discussion, spec, plan and sessions | **Topic** / a topic | 主題 | `topic` |
| Phases of a topic | Discussing, Spec, Plan, Executing, Complete | 討論中、spec、計畫、執行中、已完成 | |
| The main screen | **Sessions** (mode switch) | session | |
| The workbench behind the switch | **Code mode** | 手寫 code 模式 | |
| Things that wait for me | **Inbox** | 收件匣 (see Q6) | `inbox` |
| Its two groups | Agents are waiting / For you to look at | agent 在等你 / 等你看的 | |
| The agent's multiple-choice question | question ("Question from Claude") | 選擇題 | `question` |
| Voting | vote, "Your vote", Leading, "The vote is tied", Other | 投票、你的投票、領先、票數相同、其他 | |
| Deciding a question | Submit answer / Answer to submit | 送出答案 / 要送出的答案 | |
| Remarks under a card or a section | comment | 留言 | |
| "@name" | mention / "Ken mentioned you" | 提及 / 「Ken 提到你」 | `mention` |
| The member a session's or item's attention belongs to | **Responsible** / the responsible person / "Responsible: Ian" | 負責人 | `responsible` |
| Nobody assigned | Everyone watches / "No one: everyone watches" | 大家一起看 / 不指派：大家一起看 | |
| The other choice | Assigned people | 指派負責人 | |
| The agent asks before a command | permission request / "Claude asks for permission to run a command" | 權限請求 / 「Claude 請求許可執行指令」 | `permission` |
| Its answers | Allow once / Always allow this kind / Deny | 允許一次 / 一律允許這類 / 拒絕 | |
| What a session may do without asking | permission mode / "Asks before commands" | 權限模式 / 「執行指令前先問」 | |
| The topic's shared session | Discussion | 討論 | |
| The requirements file | spec | spec | |
| The file of work items | plan | 計畫 | |
| One unit of the plan | work item / "Item 3" | 工作項目 / 項目 3 | `item` |
| Plan actions | Generate plan / Update plan / Start / "Start 5 items" / Ask the agent to revise | 產生計畫 / 更新計畫 / 開始 / 「開始 5 個項目」 / 請 agent 修改 | |
| What the agent writes when an item is done | **Result report** | 結果報告 | `report` |
| A report that waits for its reviewer | Report to review / "Waiting for your review" | 報告待看 / 等你看 | |
| Its sections | What was done / Why it was done this way / How it was verified / What to watch out for / Changes / Follow-ups | 做了什麼 / 為什麼這樣做 / 怎麼驗證的 / 要注意什麼 / 變更 / 追問 | |
| A question about a result | follow-up / "Ask a follow-up" | 追問 | |
| The reviewer's confirmation | "I've reviewed this" / Reviewed | 我已看過 / 已看過 (see Q6) | |
| One of the side-by-side panes | column / "Close column" / "Open to the side" | 欄 / 關閉這一欄 / 在旁邊開啟 | |
| Status of a session | Running, Waiting for an answer, Waiting for permission, Idle, Done, Failed, Ended | 執行中、等待回答、等待許可、待命、完成、失敗、已結束 | |
| State of an item without a session | Not started / Waiting for another item / "Waits for 1 and 2" | 尚未開始 / 等待其他項目 / 「等待 1 和 2」 | |
| End a turn, end a session | Stop / End session | 停止 / 結束 session | |
| Tool actions | Read, Edited, Created, Ran, Searched | 讀取、編輯、建立、執行、搜尋 | |
| Who has a session on screen | "Watching now" | 正在看 | |
| Put a finished topic away | Archive topic | 封存主題 | |

Changes to existing rows: "suggestion" becomes "Proposed text sent to a session's responsible person" (zh-TW
unchanged: 建議). Style as today: sentence case in English; zh-TW keeps agent, session, spec, worktree in Latin
letters with a space on both sides, and role names in 「」 inside a sentence.

Lengths checked in `shots/01-main-zh-TW.png` and `01-main-zh-TW-1024.png`: every zh-TW label fits where its English
one fits; the longest pair is the mode switch ("手寫 code 模式"), which fits the top bar at 1024 px.

---

## 16. Limits of the mock

- Not mocked, described here only: the permission-mode menu, a session's "More actions" menu, the context menu of a
  row, the plan's "File" view, several questions in one card and questions with several answers, "Take over", the
  "New activity" button, the overlay left column below 900 px, a plain terminal as a column, toasts for new inbox
  items, the inbox count in the browser tab's title, the session selector of code mode's side column, the spec and
  plan empty states.
- The editors are pictures of the editor (the app uses the existing Monaco + Yjs editor).
- Buttons that would need a daemon show "Not part of the mock: see UX.md".
- Section comments in the spec (`shots/03-topic-3-spec.png`, "Open questions") are shown because a mention needs a
  place; they need storage outside the Markdown file. If that is too much for v0.5.0, drop them: mentions then live
  in question cards, suggestions and report follow-ups, which is what D8 lists.
- One thing found while building that the app must copy: every scrolling part of a column needs `position: relative`.
  Without it a visually hidden label inside (`.ui-visually-hidden` is absolutely positioned) escapes the column's
  clipping and makes the whole page taller than the window (measured: 85 px at 1024 × 768, fixed in `mock.css`).

---

## 17. Decisions taken without asking (say so if one is wrong)

1. The mode switch is two segments ("Sessions | Code mode"), not one toggle button: it shows where one is, and it
   carries the inbox count while in code mode.
2. A click replaces the focused column; "open to the side" adds. Links inside a column always open to the side.
3. "Idle" and "Ended" exist besides the five statuses the task named. Running is blue; green means done.
4. The inbox has two groups, and items leave only when settled (no archive); a mention leaves when opened.
5. The decider may submit at any time and against the vote; with a tie or no votes nothing is prefilled.
6. Permission cards never take the focus on a button, and have no keyboard shortcut.
7. "Always allow this kind" applies to one session.
8. Stop has no shortcut; Enter sends in the composer for messages and for suggestions alike (today a suggestion is
   sent with Ctrl+Enter).
9. One discussion session per topic also writes the spec and the plan (one place to talk about all three).
10. A result report has six fixed sections.
11. Merge requests are decided in the report column; the drawer's "Merge requests" tab goes away.
12. Columns are a personal view; nothing about them is shared.

---

## 18. Open questions (multiple choice)

Each has a default, which is what the mock shows. Q1, Q2 and Q5 change behaviour; the rest are wording or small.

**Q1. Who can be the responsible person?**
- A. Only the host and members with agent access. Simplest: the responsible person can always do everything their
  inbox asks for.
- **B (default).** Anyone but a Viewer. Being responsible routes things to one's inbox; it does not add rights. A
  responsible Editor gets the questions and the result report: votes, may submit an answer that is one of the agent's
  own options, reviews the report, asks follow-ups as suggestions. What needs agent access (free-text answers,
  accepting suggestions, allowing commands) goes to the host and the members with agent access as well. The plan's
  menu says this for an Editor ("Reviews the report and votes. Commands are allowed by Ian.").
- C. Anyone but a Viewer, and being responsible lets an Editor do everything for that session. Not recommended: an
  Editor could then steer an agent that runs as the host (ARCHITECTURE D-15).

**Q2. The decider is away and an agent waits for an answer. What then?**
- **A (default).** Nothing by itself. The host and members with agent access see "Ian is offline" and can press
  "Take over", which makes them responsible.
- B. After a set time (say 10 minutes) the question also appears in the host's inbox.
- C. Any member with agent access may submit at any time; the responsible person is only the first to be asked.

**Q3. May a session exist without a topic?**
- **A (default).** Yes, in a group "No topic" (a quick fix, a plain terminal).
- B. No: every session belongs to a topic; a quick one makes a small topic.

**Q4. Where do plain terminal sessions show?**
- **A (default).** In the session list (terminal icon), opening as a column with today's terminal panel, and in code
  mode's drawer under "Terminal".
- B. In code mode only.

**Q5. The member who opened a topic's sessions leaves or loses agent access. Today their sessions end.**
- A. Keep that rule; the Leave dialog names the work items that stop.
- **B (default, proposed).** Sessions that belong to a topic pass to the host (they run as the host anyway) and keep
  running; sessions without a topic end as today.
- C. All their sessions pass to the host.

**Q6. Three zh-TW words.**
- Inbox: **收件匣** (default; the word Gmail, Outlook and Apple Mail use in Taiwan) or 收件夾 (the word in the
  owner's brief).
- Code mode: **手寫 code 模式** (default; the owner's words) or 程式碼模式; and its counterpart segment: **session**
  (default) or 對話.
- "I've reviewed this": **我已看過** (default), 我看懂了, or 已確認.

**Q7. Is reviewing separate from merging?**
- **A (default).** Yes. "I've reviewed this" means "I read and understood it" and completes the item (D6). Merging
  stays the host's separate decision, offered in the same column right after.
- B. For the host, one button does both ("Reviewed and merge").
- C. A review by a member with agent access creates the merge request by itself.

**Q8. A fifth column.**
- **A (default).** Refused with a message.
- B. It replaces the rightmost column.
- C. No limit; the strip scrolls.

**Q9. A keyboard shortcut for the mode switch?**
- **A (default).** None in v0.5.0 (it is two tab stops from the page's start).
- B. Ctrl+` (free in Chrome on macOS, Windows and Linux as far as known; not verified against Chinese input
  methods).

**Q10. When does an item that depends on others start?** (decided outside UX, but the plan must say it)
- **A (default in the mock's wording).** When the items it waits for are merged into the main workspace.
- B. As soon as they are done, from their branches.
- C. When they are reviewed.
