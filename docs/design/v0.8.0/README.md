# The design of smurg v0.8.0, as it was written

This folder keeps the documents v0.8.0 (sticky notes) is built from, so that the reasons behind the code can be read
next to it. They are a record, not the contract: where they differ, `docs/ARCHITECTURE.md` (the binding document) and
the code are right.

- `OWNER-BRIEF.md`: the owner's brief of 2026-11-11, in the owner's zh-TW words and translated, and how it was given
  (in a git worktree, so that other features can be developed in parallel). The owner was asked nothing before the
  design was written.
- `DESIGN.md`: the design (D1 to D8: notes are Markdown files in `notes/`, the index of the daemon module `sticky`,
  Claude for the sticky notes as a confined agent session of purpose `notes`, feedback that any member may give and a
  member with agent access accepts, "Build this" that makes a topic and leaves Start to the existing Start dialog,
  Slack and Discord read from the host's computer, the notes view in the web, protocol 7 and workspace shapes 4; the
  security section, and what the owner should decide), revised after five reviews (security and honesty, the daemon
  and the protocol, the web, 0.7.0's release debt, the gate and the build order). It has no appendix of catalog
  texts: each build step writes its words in both languages and lists them in its handover.
- `ANSWERS.md`: the lead's answers to the five reviews, one entry for each of their 74 findings: taken, taken in part
  or not taken, with the decision that says so or the reason. Where an entry says "not in the design", the revised
  `DESIGN.md` did not yet answer that part when the answers were written.
- `BUILD-PLAN.md`: how the design is cut into build steps, each with the files it owns, what it does, its tests, its
  gate and its commit.

0.7.0's release debt is not paid in this branch (`DESIGN.md` D8.1): it is a release chore of main, and this folder
says nothing about how it is paid.

Not kept here: the ten understanding reports of the code at c298391, the five review reports and their evidence, and
each step's notes. The documents above name the reviews (`R-SAFE`, `R-ENG`, `R-WEB`, `R-DEBT`, `R-PLAN`) as the
evidence they answer.

The documents quote zh-TW wording on purpose (the owner's words and the interface words they decide), so the
repository's "no CJK outside zh-TW files" lint exempts this folder.

## Where the build took a side the design left open

Built in nine steps (S1 to S9, each with a check by three reviewers), on branch `worktree-sticky-notes-ui`. Each step
took the stricter, smaller or more honest side where `DESIGN.md` left room; `docs/ARCHITECTURE.md` and the code say
what was built. The sides a reader of the design would not guess:

- **Notes and their names (D1, D2).** A name is refused, never repaired (`noteNameSchema`: an NFD name is refused, not
  normalised); `sticky.name.invalid` names the one rule a name breaks. A link keeps the spelling it was written with
  and is resolved by its folded name when it is used. Of two files whose names fold equal, BOTH are refused to Claude
  for the sticky notes (G13), and the index lists the first by code unit as the note. A note's file must be a regular
  file of one link for every session, the host's too (a hard link to a source file would otherwise be writable).
  `sticky.create` refuses a 501st note before anything is written, so the index never answers with a note it does not
  list. A look at `notes/` that fails for a passing reason changes nothing and is tried again (at most 30 s apart);
  a new bus event `file.watch-error` makes the index read everything again.
- **Claude for the sticky notes (D3).** G13 needs `notes/` to exist as a real folder: Claude cannot write the first
  note, its role prompt says that a person writes it in the notes view. Its reads never reach `.smurg` (G5 at any
  depth, and a read deny rule of its profile for a search that names no path). Its role prompt also says not to repeat
  a note's name as its first heading. A start that waited its turn checks the member's role again. Its first line is
  its own ("… started Claude for the sticky notes"). Its refused requests are audited with the discussion's answer kind,
  so no stored value widened.
- **The view (D7).** A login from the notes view returns to the notes view WITHOUT the note's name, so the relay's
  login never holds one. A wiki link shows the name without its brackets; one to a note not written yet is drawn
  dashed and says so in words. A note the index could not read is never held. "Ask Claude about this sticky note"
  puts the link and a space into the draft, and a second press joins the same line: a line that is only `[...]` is
  quoted by the daemon's `agentText` as a header look-alike, so the plan's form (the link on a line of its own) would
  start every such message with a quotation. "Add a sticky note" shows only while the open note takes a change, and
  the name is sent as typed. A read of a list the page already has (the index, the session list, the feedback) keeps
  it on screen and is reported only when it fails.
- **Feedback (D4, D7.8).** Its audit detail keys are its own (`note`, `writtenBy`, `feedback`, `outsideSource`,
  `outsideId`), and the console says its decisions in its own zh-TW words (已採用、不採用、已撤回). A member author is named
  to Claude with their role at the moment of the accept, and the entry of a member who is no longer one is withdrawn
  instead of sent. While an accept is on its way nothing else changes that entry. A page of the list after an entry
  that went goes on after where it was (the places are kept in memory). The page holds the feedback only while it
  holds the whole list, so no count is ever made from a part of it. "What Claude gets" is shown only when the author's
  role is known. After `no-assistant`, "Start Claude" starts Claude and sends nothing by itself: the member presses
  Accept again. An outside author reads "Mei Chen" then "from Slack". While the index is cut at 500 notes, no group
  says that feedback is on notes that are gone.
- **Build this (D5).** The notes are read as the caller AND by the index's rules (the host's build never copies a file
  a link leads to into a spec every member reads). The linked notes are the links of the text read, so the spec and
  its text agree. A linked note not written yet keeps its heading and one fixed line. The 256 KiB bound is on the
  whole text, refused, never cut. Builds wait their turn and check the role again. "Build this" waits (disabled, with
  its reason in words) while any lock or unsaved change is on the note: the plan's side, where `ANSWERS.md` W11 said
  "not held". One dialog makes at most one topic: once a topic was made, or nobody can know, it offers only Close. A
  note names only the topics that are there; archived ones are counted and shown on request. Several builds of one
  note make topics of one name (the folders differ).
- **Slack and Discord (D6).** The channel and user id patterns are the protocol's (bounded, where D6.2 writes `{8,}`),
  and the token's form is checked too (`xoxb-` for Slack, never a person's `xoxp-`). `connectors.json` keeps a
  `connectedAt` per channel, so that a message written before a (re)connection is never taken. An empty channel's
  first read keeps a position a minute before now. A 429 is waited out and is no failure. Slack reads at most 5 pages
  of 100 a minute; beyond that the oldest are not read. A writer `users.info` will not name is "Slack user". Every
  member is sent the sources' states (`sticky.changed` goes to all), and only the host's page shows them. A
  `connectors.json` that `smurg host` may not read hands over nothing and says so.
- **The documents (S9).** The guides walk through the view in order (the guide for teammates §11; the host guide
  §4, §10 and §11). The changelogs carry the entries under `## [Unreleased]`, which the release checks allow
  (`packages/cli/test/release-checks.test.ts` checks the dated section of the version being released only). The
  security model gained three sentences, and its page bound in `apps/site/test/site.test.ts` rose with them; the host
  guide stayed within its bound. Beyond the plan, the uninstall list names the channel tokens, the Leave and remove
  dialogs name the waiting feedback that goes, `responsible.notEligible` no longer says that viewers only watch, and
  the console names the details `cut` and `cleaned` of a feedback.

## For the owner: what the build found that the design did not decide

1. **A note's name reaches the relay.** D7.1 puts the open note in the address (`/w/<id>/notes/<name>`). The relay's
   Worker serves the web app, so a full page load at that address (a reload, a link someone sent, a link opened in a
   new tab) names the note to the relay's origin; Cloudflare serves it from the assets and can log it. `SECURITY.md`,
   ARCHITECTURE §11 D-5 and the guides now say so. The other side: the name in the fragment (`/w/<id>/notes#<name>`),
   which no browser sends; it changes the route, its tests and the smoke helper.
2. **What is lost by design.** With no `Home`, a Slack or Discord message that names no note is dropped (D6.3; the
   host's notes view says so while it can happen); holding the channel instead would lose nothing. Replies in threads
   are never read. In Slack only the newest 500 since the last read are read.
3. **Who receives the sources' states**: every member, though only the host sees them; hiding them from members is a
   wire change.
4. **Linux's watcher**: a `notes/` folder that appears with its files already in it, or a path swapped for a folder
   within one batch (`@parcel/watcher` 2.6.0 reports a delete and a create as one update), can be missed by the index
   until the next change in it (ARCHITECTURE §12).
5. **Never verified against the real things**: no real model wrote a note or worked in accepted feedback, and the
   notes profile's allow rule `Edit(//<root>/notes/*.md)` ran only against the stand-in. No real bot read a channel.
   What the readers assume of the two services, from their documentation (read 2026-11-12) or from memory, to check
   with a real bot: that Discord's `after` returns the messages right after the id when more follow; Discord's
   `author.bot`, `author.system`, `author.global_name`; Discord's 401 / 403 / 404 for a bad token, no access and an
   unknown channel; Slack's `bot_id` and `app_id` on a bot's message and no `subtype` on a person's; the body of
   Slack's 429; the token forms (Slack `xoxb-…`, Discord `[A-Za-z0-9._-]{20,256}`); that `inclusive` defaults to
   false; that `conversations.history` leaves thread replies out except those also sent to the channel; that a
   Discord channel's messages leave out its threads.
