# smurg v0.5.0 — the owner's brief and decisions (2026-10-05). Binding.

## The owner's words (translated; the original is zh-TW)
"The collaborative development flow I imagine:
1. Everyone first talks with the agent together in a shared interface. The agent itself must generate multiple-choice
   questions for everyone to decide; then the agent generates a first draft of a spec; finally the developers edit it
   by hand together or ask the agent to change it (repeating the flow above).
2. Then the agent reads the spec and presents the whole development plan to everyone. After that, monitoring the
   agents and understanding the results can be assigned to different people according to the head count (this
   attention/responsibility assignment is optional; everyone can also watch everything together).
3. Then the agents start executing. I want the left side of the interface to imitate Claude: a list of sessions to
   click; the right side shows the agent sessions' conversations, and it must support viewing several sessions at
   once. Add an inbox: every user must be able to list other people's suggestions for their own sessions and the
   multiple-choice questions their sessions pop up. The inbox is also on the left, above the session list (both must
   be collapsible).
4. The VS Code-style editing interface should not be on the main screen; a toggle button at the top right lets
   people switch to a hand-coding mode.
5. The development plan and the result understanding the agent presents are also shown on the right."

## Decisions from the owner's answers
1. Sessions are CONVERSATION-style (like the Claude app): messages, tool actions, multiple-choice questions and
   permission requests are structured cards. smurg therefore runs Claude Code in a structured mode instead of a PTY.
   A plain terminal session stays available for people who need a shell.
2. A question from an agent: everyone (Host, Agent access, Editor) votes and comments, seeing each other's choices
   live; the session's RESPONSIBLE person (when nobody is assigned: the person who opened the session) presses
   "Submit" to decide, prefilled with the leading choice. Viewers only watch.
3. Roles stay: Host and Agent access send messages to agents directly; an Editor's message is a SUGGESTION that goes
   to the responsible person's inbox and reaches the agent only when accepted; Viewers watch.
4. Several TOPICS per workspace (a feature / a task); each topic has its own discussion, spec, plan and execution
   sessions; the session list on the left is grouped by topic.
5. The plan is a LIST OF WORK ITEMS; executing an item opens one agent session (its own worktree by default). The
   agent SUGGESTS who is responsible for which items given the people present; people can change it, or choose
   "no assignment, everyone watches"; then "Start".
6. Result understanding: when an item finishes, the agent writes a RESULT REPORT (what was done, why, how it was
   verified, what to watch out for) with the diff; the responsible person can ask follow-ups and presses
   "I've reviewed this". A topic is complete when every item has been reviewed.
7. The right side shows several things SIDE BY SIDE in columns (up to 3-4, draggable dividers): sessions, the plan,
   the spec, a result report. Clicking a session on the left opens it; "open to the side" adds a column.
8. Inbox (left, above the session list; both collapsible), per user: suggestions for sessions I am responsible for,
   questions from those sessions, agents' permission requests (only Host / Agent access may allow), result reports
   waiting for my review, merge requests (host), and mentions of me (@name in comments / suggestions).
9. Execution agents: file edits inside their worktree are allowed automatically; running commands (and network etc.)
   asks, in the responsible person's inbox, with "always allow this kind". Adjustable per session. Discussion / spec
   agents may only read the code and write the topic's spec / plan files.
10. Spec and plan are FILES IN THE PROJECT, versioned with git: e.g. specs/<topic>/SPEC.md and PLAN.md; people edit
    them with the built-in collaborative editor on the right, agents edit the same files.
11. The VS Code-style workbench (file tree, editor, terminal, activity…) moves behind a top-right toggle ("code
    mode"); the main screen is the sessions view.
12. Delivery: EVERYTHING in one release (v0.5.0), not staged.
Standing rules: English-first UI with zh-TW second (the v0.4.0 i18n system); MIT open source, public repository
gclinian/smurg; nobody has installed any version: no legacy / compatibility code; sessions run as the host,
unsandboxed, with the host's Claude Code login (D-15).
