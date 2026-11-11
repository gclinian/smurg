# smurg 0.8.0: design (sticky notes)

Branch `worktree-sticky-notes-ui` (from main c298391 = released 0.7.0, protocol 6, workspace shapes 3). Protocol 7,
workspace shapes 4. The package version stays 0.7.0 until a release commit (as in the 0.7.0 cycle). Written 2026-11-11
by the lead from `OWNER-BRIEF.md` and ten understanding reports of the code at c298391 (rules and languages, the wire,
storage and upgrades, documents and files, agent sessions, topics and the inbox, the web shell, the editor and the
conversation, the CLI and outside sources, the gate). Reviewed once on 2026-11-11 from five sides (R-SAFE: security
and honesty; R-ENG: the daemon and the protocol; R-WEB: the web and what a person sees; R-DEBT: 0.7.0's release debt;
R-PLAN: the gate and the build order); every finding is answered in `ANSWERS.md`, and the changes are in this text.
This document follows the form of `docs/design/v0.7.0/DESIGN.md`; the files, the tests and the commits of each step
are in `BUILD-PLAN.md`. Each step writes its words in both languages in the house style, checks them against
`docs/GLOSSARY.md` and lists them in its handover (there is no appendix of catalog texts here).

## The design in five minutes

**What the owner asked.** A simpler way to work together: everyone writes small sticky notes in a note-taking
interface, an AI chat on the right edits them, the notes link to each other with wiki links and grow from one first
note like a tree. Everyone can give an opinion on a note; developers approve; the model turns approved opinions into
notes or into a prompt that an agent builds. Opinions can also come from Slack or Discord.

**A sticky note is a small Markdown file in the shared folder**: `notes/<Name>.md`. The first one is
`notes/Home.md`. `[[Name]]` in a note links to `notes/Name.md`; a link to a note that does not exist yet leads to a
page that offers to write it. Because a note is a file, what smurg already does for a file holds for a note: people
edit it together live (Yjs, cursors, locks), an agent's edit is merged into what people have open, it can be
committed, and code mode shows it.

**The screen.** A third view, "Sticky notes", at `/w/<id>/notes`, beside the sessions view and code mode (top bar:
Sticky notes, Sessions, Code). Left: the tree of notes, grown from Home by the links. Middle: the open note as one
sticky note, read as Markdown with its links; "Edit" for the shared editor; "Add a sticky note"; under it the
feedback on this note. Right: the conversation with Claude for the sticky notes.

**Claude for the sticky notes** is one agent session per workspace of a new purpose, `notes`. Like a topic's
discussion it runs no command and its mode is fixed; it may read the project and may write only `notes/<Name>.md`.
smurg's own tool gate enforces that (§0 rule 7), not Claude Code's rules alone. A member with agent access starts it
and writes to it directly; an Editor's message is a suggestion, as in every session.

**Feedback.** Any member, a Viewer too, can leave feedback on a sticky note. Feedback reaches no agent by itself. A
member with agent access accepts it (exactly the characters shown) or rejects it. Accepted feedback goes to Claude
for the sticky notes as the accepting member's own message that quotes it, and Claude works it into the notes: it
changes that note, or writes a new one and links it. Everyone sees what was written, because it is a note.

**From a note to a built feature.** "Build this" on a sticky note, for a member who may start sessions: the dialog
shows the exact text that becomes the spec (the note and the notes it links to directly); on confirm smurg makes a
topic with that spec and a plan of one work item, and opens it in the sessions view, where the member presses Start
in the Start dialog smurg already has. From there 0.7.0 applies unchanged: the Start dialog's checks and pins, a
work item in its own worktree, a result report, merging by itself when the report is in order. The text an agent
builds from is therefore confirmed at Start by a member with agent access, as every spec is.

**Slack and Discord.** The host connects a channel with `smurg connect slack` or `smurg connect discord`. The host's
computer reads that channel's new messages over HTTPS once a minute (the relay is not involved and never sees them)
and each message becomes feedback, from a person who is not a member, on the note the message names with `[[Name]]`,
else on Home. Such feedback is shown as written and waits to be accepted like any other. No model reads it before.

## Decisions

### D1. Notes are files

1. The folder is `notes/` at the top of the main workspace, flat (no folders below it: Linux's watcher misses
   folders created in one burst, ARCHITECTURE §12). A note's name is its file name without `.md`. `NOTES_DIR =
   'notes'` and `NOTES_HOME = 'Home'` are constants of `packages/protocol/src/schema/paths.ts`, next to `SPECS_DIR`.
   The first note's name is `Home` in both languages (file names are not translated).
2. A note name (`noteNameSchema`, with `NOTE_NAME_MAX_CHARS` = 80 UTF-16 units after NFC, so at most 243 bytes with
   `.md`): no character of `/ \ [ ] | # ^` nor of `` ` * _ ~ < > & @ `` (so that Markdown never splits a link); no
   white space other than U+0020; no control, bidi, line-separator (U+2028, U+2029) or invisible character: precisely,
   `agentText(name)` returns the name unchanged and not cleaned; not `.` or `..`; no leading or trailing space or dot;
   `notes/<name>.md` passes `checkRelPath` and is not a host-only name (for every principal: `notes/CLAUDE.md` is
   never a note); the name passes `topicNameSchema` and the PLAN.md heading rule (a build uses it as both). One pure
   predicate of `packages/protocol`, `noteNameOf(path)`, says whether a root-relative path is a note's file
   (`notes/` + one segment + the literal suffix `.md` + a valid name) and is the one test the gate, the index and
   `sticky.create` use. `notePath(name)` is its inverse.
3. Names are compared folded (`foldRelPath` of the path): Home and home are one note. The index maps the folded name
   to the name on disk, and every link resolves to that on-disk name. Of two files whose names fold equal (possible
   on Linux), the one that sorts first by code unit is the note and the other is listed `shadowed` with no links.
4. A wiki link is `[[Name]]`. There is no label form in this version. `wikiLinks(text)` of `packages/protocol` is
   the one finder: one pass, bounded link length, no regular expression that can go quadratic over member text
   (listed in the text-cost tests of the packages that call it). The daemon's index runs it on the raw text and
   skips fenced code and code spans; the web renderer runs it on each plain text run that marked produced. The two
   agree wherever a whole `[[Name]]` is one plain run, which the name rules of D1.2 make the normal case; a
   disagreement only about what counts as code is accepted and pinned by a test that names it.
5. A file in `notes/` over `NOTE_MAX_BYTES` (64 KiB) is listed with its name and no links (`oversized`); a file that
   is not valid UTF-8 is listed `unreadable`; a file whose name is no valid note name is not a note (counted,
   `invalid`). They stay files like any other.
6. No rename and no delete from the notes view in this version (a rename would have to rewrite links). Code mode's
   file tree still renames and deletes; the index follows the files.

### D2. The index (daemon module `sticky`, wire `sticky.*`)

1. One daemon module, `packages/daemon/src/sticky/`, owns everything of this design on the host: the index, the
   feedback, the builds, the outside sources. One wire prefix, `sticky`.
2. The index of `notes/*.md` of the main workspace is kept in memory: for each note its on-disk name, the names it
   links to (in order, each once, at most `NOTE_LINKS_MAX` = 32, a target that is no valid name is dropped) and its
   flags (D1.3, D1.5). Nothing else of a note's content is in the index or on the wire: no excerpt, no size, no
   time, so typing in a note changes the index only when its links change. It is built by listing `notes/` at start
   and kept up to date from the bus event `file.changed` (debounced, as `topics/core.ts` does), with a full listing
   again when the folder itself appears or disappears and after a watcher error. Each note is read as a member
   without rights would read it, never as the privileged system principal: not a symlink, a regular file, one hard
   link, the resolved path a note's file; a file that fails is listed by name, `unreadable`. A `notes` that is a
   symlink counts as no folder. Reads never block the event loop. At most `NOTES_MAX` = 500 notes; more are counted
   and said (`truncated`). The index sees what is on disk: text people typed arrives with the autosave (within about
   two seconds).
3. The tree is derived, never stored: breadth first from Home along the links; a note's parent is the first note
   that reaches it; notes Home does not reach are "not linked". A pure function of `packages/protocol`
   (`noteTree(notes)`) used by the web.
4. Wire. `sticky.list` (request, `file.read`, the list rule: `{ after? }` → `{ notes, hasMore, truncated, sources }`)
   and `sticky.changed` (event to every member who may read files: `{ upserted: NoteInfo[], removed: string[],
   truncated, sources? }`, one change at a time, never the whole list). `NoteInfo = { name, links, oversized?,
   unreadable?, shadowed?, builds? }`; `builds` are the topic ids made from this note (the newest 8). `sources` is
   the state of the outside sources (D6.4). The worst case of every message fits one envelope and is in
   `worst-case.fixture.ts`.
5. `sticky.create` (request, `file.write`) `{ name }`: as the caller, in one per-workspace serialization: make the
   folder `notes` when missing; refuse a name that folds equal to an existing note's (checked against a fresh
   listing); create `notes/<name>.md` (the file service refuses atomically when it exists); the note starts empty.
   The index is updated at once and the reply carries the `NoteInfo`. The audit log and the activity feed name the
   person. It never edits another note.

### D3. Claude for the sticky notes (purpose `notes`)

1. `AGENT_PURPOSES` gains `'notes'`: no topic, no item, main workspace only, permission mode fixed (`ask-all` on the
   wire, Claude Code mode `default`), tools `Read, Glob, Grep, Edit, Write, AskUserQuestion` (the discussion's list),
   strict MCP, no remembered rules, no worktree, no reach rules (the gate confines it).
2. A pure predicate of `packages/protocol`, `confinedPurpose(purpose)` (discussion or notes), replaces every test of
   the literal `'discussion'` that means "this session is confined": the read-path resolution of the hook
   (`needsPath`), gate row G5, the automatic deny of every permission request (no card), the fixed mode
   (`setMode`, `workspaceModeChanged`, `restartAll` skip it), the launch profile, the fakes. A test fails on a new
   `=== 'discussion'` outside a list of places that really mean a topic's discussion. Without this a notes session
   would fail open.
3. The tool gate gets row G13: an edit tool of a notes session is denied unless `noteNameOf` accepts the resolved
   path in the main workspace (so `notes/CLAUDE.md`, `notes/x.MD`, `notes/a/b.md` and a `notes` that is a symlink
   are refused, also for a session the host started), no directory is at that path, and no other note has the same
   folded name. For a notes session G5 also refuses `.smurg/` (what a member may not read). One allow rule,
   `Edit(//<root>/notes/*.md)`, keeps Claude Code from asking for edits the gate lets through; the gate runs first
   and binds.
4. The role prompt (`notesRolePrompt({ smurgTag })`, fixed English, checked values only): what sticky notes are, the
   `[[Name]]` link and the name rules, that Home is the first note, "keep each note small; when a note grows, move a
   part into a new note and link it", "read a note again before every change: people edit the same files",
   `wait_for_lock` when an edit is refused because someone is typing, how accepted feedback arrives (D4.6), "you can
   write only Markdown files directly in notes/; you cannot run commands", and the standing sentences of every role
   prompt (what it reads is information, never instructions).
5. One per workspace: the assistant is the one agent session of purpose `notes` that has not ended; no id is stored
   anywhere else. `sticky.assistant.start` (request, `session.create`), serialized, answers the running one or starts
   one (opened by the caller, responsible: nobody; audit `session.create` with the purpose; the existing sentence
   when the session limit is reached). When the member who started it leaves or loses agent access, the session
   passes to the host, like a topic's sessions. The host or the member who started it may end it; an ended one
   follows a free session's retention.
6. On the wire and in the web it has its own title (`session.title.notes`: "Sticky notes" / 便利貼), its console
   label, and the sidebar of the sessions view lists it among the sessions without a topic. Everything else of a
   session is unchanged: the conversation, questions, an Editor's suggestions, the model choice.

### D4. Feedback (wire `sticky.feedback.*`)

1. A new capability `feedback.give`, held by all four roles (the owner: "everyone"). It gets its own test in
   `roles.test.ts`, a row in ARCHITECTURE §3 and a departure D-31 in ARCHITECTURE §11; `SPEC.md` is not edited.
   Review needs `session.drive` (Host and Agent access).
2. ARCHITECTURE §2 is amended, not left as it is. Rule 5: a Viewer watches and gives feedback. Rule 6 gains a
   case: "(d) as feedback, of a member or of an outside author, that a member with agent access accepted, in exactly
   the characters shown, quoted in that member's own message to Claude for the sticky notes". And one stated,
   unavoidable case: Claude for the sticky notes reads `notes/*.md`, whoever wrote them; it can only write notes.
3. The entity: `{ id, note (a note name), text (at most FEEDBACK_TEXT_MAX_CHARS = 4000, cleaned with agentText at
   creation, `cleaned` recorded), author, status: 'waiting' | 'accepted' | 'rejected' | 'withdrawn', createdAt,
   decidedBy?, decidedAt?, rejectReason? }`. `author` is `{ kind: 'member', user: UserRef }` or `{ kind: 'outside',
   source: 'slack' | 'discord', name, externalId }` (D6.3 says how the two strings are cleaned and checked). The
   words are the suggestion's: Accept / 採用, Reject / 不採用.
4. Wire: `sticky.feedback.create` [`feedback.give`] `{ note, text }` (the note must be in the index, else
   `not-found`; rate bucket of suggestions); `sticky.feedback.withdraw` [the member who wrote it, while waiting];
   `sticky.feedback.accept` [`session.drive`] `{ feedbackId }`; `sticky.feedback.reject` [`session.drive`]
   `{ feedbackId, reason? }`; `sticky.feedback.list` [`file.read`, the list rule]; event `sticky.feedback.updated`
   to every member (one entry, or the id of a removed one).
5. Stored in the module's one document, `sticky.json` (`{ version: 1, feedback, cursors, builds }`, `canSetAside`
   false, `DOCUMENT_SINCE` not published). Bounds: `FEEDBACK_MAX` = 1000 entries and `FEEDBACK_STORED_MAX_CHARS` =
   2 Mi characters together; a withdrawn entry is removed at once (the audit keeps it); when a bound is reached the
   oldest rejected entries go first, then the oldest accepted; waiting ones are never dropped: a create is refused
   instead (`feedback-full`). Waiting at once: at most 20 per member, 300 from members together, 200 from outside
   sources together and 20 per outside person. When a member is removed their waiting feedback is withdrawn (audit
   by the system).
6. Accept: the caller holds `session.drive`; the feedback is waiting; the assistant exists and has not ended (else
   `no-assistant`: the page offers to start it). The daemon then sends ONE message to the notes session with
   `ConversationService.send` as the accepting member, origin `composer` (no new origin): the text of the pure
   `composeFeedback({ note, author, text })` of `packages/protocol` (next to `composeRevise`): a fixed English
   sentence that names the note's path as a JSON string and the author (a member by `agentSafeName` and role; an
   outsider as "a person outside the workspace" with `outsideSafeName(source, name, externalId)`, whose fallback is
   "a Slack user" / "a Discord user", never "member"), then the feedback inside `quoteForAgent('feedback', text)`.
   The status becomes `accepted` only after the send succeeded; a second accept of the same id while one is under
   way is refused. This is the ONLY place where feedback text goes to an agent; a test pins it (one send in
   `src/sticky/`, inside accept, after the capability and status checks), as `suggestions.test.ts` pins `accept`.
7. Rejecting and withdrawing send nothing. A reviewer does not edit feedback in this version.
8. Audit actions `sticky.feedback.create`, `.accept`, `.reject`, `.withdraw` and `sticky.build`, each with its
   console label in both languages (full text kept as for suggestions; a source's create is audited by the system
   with the source and the outside id in the detail). No inbox kind in this version: the notes view shows the
   waiting count to the members who can review.

### D5. Build this note (wire `sticky.spec`, `sticky.build`)

1. `sticky.spec` (request, `session.create`) `{ note }` → `{ text, hash, notes }`: the daemon composes, reading as
   the caller, the text that would become the spec: one line "Built from the sticky note <path as a JSON string>.",
   the note's text, then each note it links to directly (at most `NOTE_LINKS_MAX`, each at most `NOTE_MAX_BYTES`,
   together at most `SPEC_FROM_NOTES_MAX_BYTES` = 256 KiB) under a fixed heading with its path as a JSON string,
   and a fixed last line that says other sticky notes are not part of this spec. Texts are decoded as `doc.open`
   decodes them (LF, no BOM). `hash` is the SHA-256 of the UTF-8 of `text`; `notes` are the names included.
2. `sticky.build` (request, `session.create`) `{ note, hash }` → `{ topicId }`: the daemon composes again and
   refuses another hash (`note-changed`: the page shows the new text). It checks first what can be checked: the
   topic limit, a free slug (it picks the slug itself: from the name, never one whose folder `specs/<slug>` exists
   or is stored; `-2`, `-3` … up to a small bound, then `slug-unavailable`), that the generated PLAN.md parses. Then,
   as the caller: `topics.create({ name, slug })`; write `specs/<slug>/SPEC.md` (the composed text) and a one-item
   `PLAN.md` (item id `build`, title the note's name) through the file service; record the build
   (`{ note, topicId, by, at, hash }`, at most 200, oldest dropped) as soon as the topic exists; audit
   `sticky.build`. It starts nothing.
3. The page then opens the topic's plan in the sessions view. The member presses Start there: the existing Start
   dialog with its preflight (hand edits, invisible characters, how the items run, merging, the pins). ARCHITECTURE
   §2 rule 6(b) therefore covers a build with no new case. The dialog of "Build this" shows `text` as plain,
   visible text (never rendered Markdown), with the invisible-character warning, and says that Start comes next.
4. When a step fails after the topic exists, the topic stays with what was written and the error names the step; the
   note shows the topic (D2.4 `builds`).
5. The discussion session that `topic.create` always starts is kept: it is where people talk about that feature.

### D6. Outside sources (`packages/daemon/src/sticky/`, CLI `smurg connect`)

1. Outbound only, from the host's computer: `fetch` over HTTPS on a timer (60 s per source, never more often), no
   new dependency, nothing through the relay. Slack: `conversations.history` of one channel with a bot token, names
   through `users.info` (cached). Discord: `GET /channels/<id>/messages?after=<last id>` with a bot token. Every
   request has `redirect: 'error'`, a timeout and a cap on the bytes read. The two base URLs are fixed in the code
   and replaceable only through `DaemonOptions` (tests: fake servers on 127.0.0.1; no test uses a real token, §0
   rule 2), never through a file, a flag or the environment.
2. The secret: `~/.smurg/connectors.json` (mode 0600, the existing private-file helpers; `{ version: 1, workspaces:
   { <workspaceId>: { slack?: { token, channel }, discord?: { token, channel } } } }`), listed in `STATE_ENTRIES`
   (so `smurg uninstall` knows it), in the persisted kinds and in ARCHITECTURE §7.1. `smurg connect slack|discord
   [folder] --channel <id>` checks the channel id by pattern (Slack `^[CG][A-Z0-9]{8,}$`, Discord `^[0-9]{17,20}$`)
   and reads the token without echo (`io.readSecret`); `smurg disconnect slack|discord [folder]` removes it. `smurg
   host` hands the workspace's entry to the daemon in the same process, as it does with the relay login, and reads
   the file again every few seconds. A token is never on the wire, in `state.json`, in the audit log or in the
   environment; the masks learn the forms that have a literal prefix. No control-socket operation (agent sessions
   can reach that socket). The host guide says that agent sessions, which run as the host, can read this file as
   they can read the relay login, and names the smallest scopes of each bot. The daemon checks each channel id by the
   same pattern when it reads the file: a source whose id fails is `failing` and is never fetched. The host's words
   go into a new last section of HOSTING (§11, both languages, nothing renumbered); the step that writes it measures
   the built page and raises the page bound of the site's test by what the text adds, with the reason beside it.
3. The first read of a channel only sets its cursor to the newest message: nothing from before the connection
   becomes feedback. Cursors are kept per source and channel in `sticky.json`; another channel starts from now; so
   does a missing cursor. Each later message of a person (not of a bot, not empty) becomes feedback through the
   feedback service: the text goes through `agentText` (Slack's `&amp; &lt; &gt;` decoded first), is cut at
   `FEEDBACK_TEXT_MAX_CHARS` on a code-point boundary and marked cut; the author's name is cleaned (nothing unseen,
   white space collapsed, at most 256 characters, fallback "Slack user" / "Discord user") and the outside id is
   checked by pattern; the note is the first `[[Name]]` of the message that names an indexed note, else Home; with
   no Home it is dropped and counted. No model reads it before a member accepts it. When an outside budget (D4.5) is
   full the source stops reading until there is room.
4. Each source's state (`reading`, `waiting-for-room`, `failing` with a catalog code) is in `sticky.list` and
   `sticky.changed` (`sources`), for the host to see that it works.

### D7. The web

1. Route `{ name: 'notes'; workspaceId; note? }`, one anchored pattern for `/w/<id>/notes` and
   `/w/<id>/notes/<name>`; the name is encoded with `encodeURIComponent`, decoded inside a `try` (a failure is the
   not-found page) and checked with `noteNameSchema`; a valid name with no note is the "not written yet" page.
   `/w/<id>` stays the sessions view (see "What the owner should decide"). `WorkspaceMode` gains `'notes'`; every
   place that decides the mode with a ternary or a `:not()` selector is restated over three modes
   (`WorkspaceShell.goTo`, `WorkspaceRoute.viewPath`, the top bar's toggles, the smoke helper `toMode`).
2. `app/workspace/NotesView.tsx`, loaded lazily like the workbench and mounted on first show, composes tree | note |
   chat with split panes (pane widths under `smurg.pane.notes-tree` and `smurg.pane.notes-chat`; no field is added
   to `smurg.layout`; no layout toggles), its own skip link and F6 stops. The open note is in the address; the
   expanded rows and an unsent feedback text live in memory only.
3. Feature folder `apps/web/src/features/sticky/` (lowercase letters only: the string lints find folders by that
   pattern): the tree, the note, the feedback, the dialogs; `model.ts`, `strings.ts`, `strings.zh-TW.ts`,
   `sticky.css`, tests with a zh-TW suite. It imports exactly `editor/standalone.tsx` and `markdown/index.ts` of
   other features (two named lines in the feature-imports test). Store area `lib/stores/sticky.ts` (notes by folded
   name, feedback by id, sources; selectors for the tree and for a note's feedback). The notes index loads when the
   notes view is first shown, not with every channel. For a member with `session.drive`, `sticky.feedback.list` and
   its event load with the channel, so that the waiting count on the mode link (D7.8) is right in every view.
4. The tree: `ui/Tree` gains an opt-in prop so that a row with children can be opened (Enter, Space and a click
   open the note and unfold it; the twisty only folds); the default is unchanged. Groups below the tree: "Not linked"
   and, for members who can review, "Feedback on sticky notes that are gone" (names with waiting feedback that the
   index does not hold).
5. The open note: only a note the index lists (or one `sticky.create` just answered for) is held as a shared
   document (`useHeldDocument`, `useDocumentText`), keyed by its folded name. Read view: the Markdown renderer with a
   new synchronous option `wikiLinks` (off inside code spans and link words; every wiki link is an `<a href>` to the
   note's route, titled "Open the sticky note {name}"; a link to a missing note is drawn differently and says so in
   words, not by colour alone); one line when an agent holds the note's lock ("Claude is writing this sticky note.").
   "Edit" shows the shared editor (`StandaloneDocument`, without its "Send to agent" menu) for that one note, in the
   lazy chunk so Monaco stays out of the workspace chunk; a Viewer has no "Edit". "Add a sticky note" (only while
   the note is writable and synced) asks for a name, calls `sticky.create`, then adds `- [[Name]]` to the open note
   in one local transaction of the shared document; when the note became read-only in between, it says so and the
   new note is under "Not linked".
6. Pages without a note: no `notes/Home.md` yet: "Write the first sticky note" for a member who may write, a
   sentence for the others. A valid name that is not written yet: "Write this sticky note" for `file.write`, a
   sentence for a Viewer, and that name's feedback.
7. The chat: a `ColumnFrame` on `{ kind: 'session', sessionId }` of the notes session, keyed by the session id.
   States: a spinner until the session list is loaded; no assistant or an ended one: "Start Claude" / "Start Claude
   again" for `session.create`, a sentence for the others; an Editor sees that messages are suggestions (the
   composer's own line); a Viewer has no box. "Ask Claude about this sticky note" (members with a composer) puts
   `[[Name]]` into the composer's draft. While the notes view is shown, a link to `notes/<name>.md` in the
   conversation opens that note in the notes view, not code mode.
8. Feedback under the note: for everyone a box "Give feedback" and their own waiting feedback with "Withdraw"; the
   list (waiting first, each with its author, "Slack" / "Discord" for an outside author and never an avatar, the
   time, the text as plain text; settled ones folded behind "Show N earlier"); "Accept" and "Reject" and the waiting
   counts (on the mode link, on a note's row) only for `session.drive`. Before the click, Accept can show, as plain
   text, the exact message `composeFeedback` makes ("What Claude gets"). Accept with no assistant offers "Start
   Claude". "Build this" for `session.create`, with the dialog of D5.3.

### D8. Upgrade and the wire

1. 0.7.0's release debt is NOT paid in this branch. It is a release chore of main (`docs/RELEASING.md` §4.5): its
   fixture is made by a driver carried to 0.7.0's story, about 450 generated files, and two fixtures of one version
   made in two branches cannot be merged. Until it is paid the upgrade tests still treat 0.7.0 as not published
   (`TAG` is `v0.6.0`), and this branch's new points join the same lists. When the debt lands on main, this branch
   is rebased and its points stay "not published yet"; that rebase restates `other-version.test.ts` over the declared
   steps (the upgrades expected from the tag are the steps above the tag's shapes: none for shapes 4).
2. Protocol 7: every wire change of this design is behind one version step, raised in the first build step. The
   control socket's Welcome gains one required key, `protocol` (the number), so that a command and a daemon of
   different protocols refuse each other for this and every later step; a 0.7.0 page and a 0.8.0 host refuse each
   other at the handshake as today.
3. Workspace shapes 4: one new document (`sticky.json`), wider stored enums (the purpose, audit actions), one new
   command file (`connectors.json`). No existing document changes shape otherwise, so there is no frozen `v0.7.0`
   shape and no step (0.6.0 and 0.7.0 widened enums the same way); where the pin shows otherwise, the step comes
   with it (CONTRIBUTING, "When you change something smurg stores"). A folder this branch opened is refused by 0.7.0
   as written by a newer smurg: there is no way back for that folder.

## Security

- Feedback that nobody accepted (a Viewer's, an outsider's) is read by no model: the index and the sources are plain
  code, and the note a Slack message lands on is chosen by a text match. Accepted feedback is sent once, quoted, in
  the accepting member's name (ARCHITECTURE §2 rule 6, new case d).
- What Claude for the sticky notes writes is a note, in front of everyone, and builds nothing. It reads the project
  as a discussion does, and every note whoever wrote it: a note is therefore a text that reaches this one agent
  unaccepted, which is why the agent can only write notes and run nothing (G13, enforced by smurg).
- A built note's work item merges by itself, on the host's standing consent, once ONE member with agent access
  confirmed the spec at Start, as for every topic. The spec holds the note and the notes it links to directly, shown
  in full before the topic is made. The item's agent can still read other files of the main folder, as today;
  feedback from a Viewer or from outside needed an acceptance before it could change a note.
- An outside author is never a member: no role, no mention, no inbox, no avatar, always the source's name beside
  theirs. Their names and texts are cleaned and bounded before they are stored or shown, and are in the workspace's
  state; an accepted text is in the audit log. One person in the channel can fill at most their own budget.
- Tokens and the two fixed hosts: D6.1, D6.2. The daemon connects to them only when the host connected a channel.
- `SECURITY.md`, `docs/SECURITY-MODEL.md` and the host guide follow ARCHITECTURE §2 in the documents step: what
  reaches an agent gains case (d), a Viewer gives feedback, and a built note's item merges by itself once one member
  with agent access confirmed its spec at Start.

## What the owner should decide

Each line: the side this design takes, and what the other side costs.

1. **Sticky notes is a third view, not the screen people land on.** Landing on it (notes at `/w/<id>`, sessions at
   `/w/<id>/sessions`) changes the pinned route tests, the smoke harness that every browser test joins through, the
   quick start and both guides (they tell people to press "New topic" after opening their link), the product page's
   picture and the README's picture (re-measured on macOS only). It is one more build step once the interface is
   liked.
2. **The sessions view and topics stay as they are.** "Build this" makes a topic; removing the old flow is a
   separate decision.
3. **A Viewer can give feedback** (a new capability held by all four roles). The brief says "everyone".
4. **"Developers" are Host and Agent access.** An Editor cannot accept feedback: accepting sends text to an agent.
5. **Claude turns accepted feedback into notes at once; building is a separate act with its own confirmation at
   Start.** "Accept and build in one click" would let a model-written prompt start an agent unread, and 0.7.0 merges
   by itself.
6. **Reviewers do not edit feedback before accepting** (accept as written, or reject and write to Claude yourself).
7. **No inbox item for waiting feedback** in this version (a new inbox kind and column target); the view shows the
   count to those who can review.
8. **Slack and Discord are read once a minute over HTTPS, one channel each per workspace.** A live connection (Slack
   Socket Mode, the Discord Gateway) is more code for a delay of at most a minute.
9. **Notes live in `notes/` of the project and nobody commits them automatically.** A work item's worktree has only
   what was committed, which is why a build copies the notes' text into the spec.
10. **No rename or delete of a note from the notes view, and no `[[Name|label]]`** in this version.
11. **0.7.0's release debt stays open** (D8.1): paying it is a release chore of main, and it must be paid once.
