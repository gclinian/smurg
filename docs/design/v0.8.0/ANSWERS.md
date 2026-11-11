# The lead's answers to the review of DESIGN.md (2026-11-11, before the build)

The first draft of `DESIGN.md` was reviewed from five sides: R-SAFE (security and honesty), R-ENG (the daemon and
the protocol), R-WEB (the web and what a person sees), R-DEBT (0.7.0's release debt) and R-PLAN (the gate and the
build order). They found 74 things: 2 blockers, 48 major, 24 minor. Each has one entry below, under its review. The
ids are the reviews' own, except that R-ENG's are written `E-F1` and on, and R-PLAN's `P-F1` and on, so that no id
is used twice.

Each entry: the finding in one sentence; then "Taken", "Taken in part" or "Not taken"; then where the revised
`DESIGN.md` says so, or why not. The decision numbers are those of the revised text. The reviews quote the first
draft's numbers, which moved (for example the index was D2.1 and is D2.2; the send of accepted feedback was D4.5 and
is D4.6). "Belongs to `BUILD-PLAN.md`" means the design takes the side and leaves the file or the test to the step
that owns it. "Not in the design" means the revised text does not say it yet.

Most entries that are not taken follow from seven sides the lead took:

- 0.7.0's release debt is not paid in this branch (D8.1, "What the owner should decide" 11).
- One daemon module, one wire prefix (`sticky`) and one stored document (`sticky.json`), not two (D2.1, D4.5).
- "Build this" starts nothing: it makes the topic, and the member presses Start in the Start dialog smurg already
  has (D5.2, D5.3). That answers every finding about the pins, direct mode and merging at Start.
- No excerpt of a note on the wire (D2.2).
- No assistant id stored anywhere (D3.5).
- No new message origin (D4.6).
- "Add a sticky note" stays, in the safe order (D7.5).

## R-SAFE: security and honesty

- **SAFE-01** (blocker). `sticky.build` started the plan with the pins preflight read after the daemon wrote the
  files, so an Editor's edit in between would be pinned and built unseen. Taken in part: `sticky.build` starts
  nothing (D5.2); the member presses Start in the existing Start dialog, whose preflight and pins cover what that
  member sees at Start, hand edits included (D5.3). No hash of the written bytes goes to `plan.start`, because
  nothing starts from `sticky.build`.
- **SAFE-02** (major). "Build this" skipped the Start dialog: direct mode without the host's confirmation, merging
  chosen silently, no invisible-character warning, no hand edits. Taken: D5.2 (it starts nothing), D5.3 (the
  existing Start dialog with its preflight).
- **SAFE-03** (major). The Build dialog must show the note's source as visible text, warn about invisible
  characters, name who edited the note, hash what the daemon read as the caller, and be audited. Taken in part:
  plain visible text with the warning (D5.3); the text read as the caller and hashed (D5.1); the path as a JSON
  string (D5.1); the audit action `sticky.build` (D4.8) and the hash in the build record (D5.2). Rule 6(b) needs no
  new case, because the confirmation is the Start dialog's (D5.3). Who edited the notes is taken in part: the Build
  dialog does not name the people, but it shows the full text, and the Start dialog that follows names hand edits
  (D5.3).
- **SAFE-04** (major). SPEC.md copied only the note, while the notes it links to reach the item's agent unpinned
  from the main folder. Taken: D5.1 (the note and the notes it links to directly, bounded, one hash over the whole
  text, a fixed last line), the third Security bullet (reworded: the item's agent can still read other files, as
  today).
- **SAFE-05** (major). The index read notes as the privileged system principal, so a symlinked or hard-linked note
  could show part of a host-private file to every Viewer. Taken: D2.2 (each note read as a member without rights
  would read it; and no excerpt on the wire at all), D5.1 (the build reads as the caller).
- **SAFE-06** (major). The new purpose is confined only if every test of the literal `'discussion'` is restated, or
  the session fails open. Taken: D3.2 (`confinedPurpose`, the places it replaces, a test that fails on a new
  comparison with `'discussion'`). The automatic deny is the discussion's own, so no answer kind is added. The
  gate's cases belong to `BUILD-PLAN.md`.
- **SAFE-07** (major). Only G13 stops a notes session the host started from writing `notes/CLAUDE.md`; a folded
  compare lets `x.MD` through, case twins and directories are not excluded, and the allow rule is wider than the
  gate. Taken: D1.2 (`noteNameOf`, host-only names refused for every principal), D1.3 (twins), D3.3 (G13 on the
  resolved path, no directory, no folded twin, the allow rule `Edit(//<root>/notes/*.md)`).
- **SAFE-08** (major). A note name could hold U+2028, U+2029 or an invisible character, the path stood bare in the
  fixed sentence, and `feedback.create` did not check the note. Taken: D1.2 (`agentText(name)` returns the name
  unchanged and not cleaned; no white space but U+0020), D4.6 (the path as a JSON string), D4.4 (the note must be in
  the index, else `not-found`).
- **SAFE-09** (major). Name the author safely, compose the message in one pure function that the web also shows, add
  a message origin, pin the one send, and amend rule 6 and SECURITY.md. Taken in part: `composeFeedback` in
  `packages/protocol` with the fixed label `feedback`, the author in the fixed sentence, `outsideSafeName` with the
  fallback "a Slack user" / "a Discord user", the one send pinned by a test (D4.6); before the click, Accept can show
  as plain text the exact message `composeFeedback` makes ("What Claude gets", D7.8); ARCHITECTURE §2 rule 6 case
  (d) and rule 5 (D4.2), which `SECURITY.md` follows in the documents step: what reaches an agent gains case (d),
  and a Viewer gives feedback (Security, last bullet). Not taken: a new message origin (D4.6: the origin is
  `composer`, so no stored enum widens). Where SECURITY.md's table of points says so belongs to `BUILD-PLAN.md`.
- **SAFE-10** (major). "Two confirmations by members with agent access" was false for a note an Editor wrote. Taken:
  the third Security bullet (one member with agent access confirms the spec at Start), and the last: `SECURITY.md`,
  `docs/SECURITY-MODEL.md` and the host guide follow ARCHITECTURE §2 in the documents step, so they say that a built
  note's item merges by itself once one member with agent access confirmed its spec at Start.
- **SAFE-11** (major). The test base URLs, redirects, timeouts, response size and an unchecked channel id in the URL
  path could send the bot token elsewhere. Taken: D6.1 (base URLs only through `DaemonOptions`, `redirect: 'error'`,
  a timeout, a byte cap), D6.2 (the channel pattern at `smurg connect`, and again when the daemon reads
  `connectors.json`: a source whose id fails is `failing` and is never fetched; no token in the environment, the
  guide's sentence and the smallest scopes).
- **SAFE-12** (minor). Discord tokens have no prefix to mask, outside names are unchecked, one person can fill the
  outside budget, the audit of a source's create is unclear, and avatars are not forbidden. Taken in part: the masks
  learn only the forms with a literal prefix, so nothing is claimed for Discord (D6.2); names and ids cleaned and
  checked (D6.3); 20 waiting per outside person (D4.5); a source's create audited by the system with the source and
  the outside id (D4.8); never an avatar (D7.8, Security). The Security sentence "an accepted text is in the audit
  log" stays: it is true, and every create is audited with its full text as well (D4.8).
- **SAFE-13** (minor). Viewers could fill the feedback bounds, withdraw loops push out settled entries, two lists
  exceed the list rule, and `sticky.changed` resends everything. Taken: D4.5 (a withdrawn entry removed at once,
  rejected entries evicted before accepted ones, 300 waiting from members), D4.4 (the list rule), D2.4 (one change
  at a time). The list is paged under the list rule, not per note.
- **SAFE-14** (minor). The notes agent can read `.smurg/uploads`, the excerpt is shown with bidi characters and cut
  mid pair, and a labelled link can hide its target. Taken: D3.3 (G5 also refuses `.smurg/` for a notes session),
  D2.2 (no excerpt), D1.4 (no label form).

## R-ENG: the daemon and the protocol

- **E-F1** (major). The index exceeds one envelope at the stated maxima and is resent whole at every autosave.
  Taken: D2.2 (no excerpt, size or time; `NOTE_LINKS_MAX` = 32), D2.4 (the list rule, `sticky.changed` carries one
  change, `NoteInfo` has no path, the worst case in `worst-case.fixture.ts`).
- **E-F2** (major). `feedback.list` was not paged and reaches about 12 MB. Taken: D4.4 (the list rule).
- **E-F3** (major). Rule 6 is a closed list, Claude for the sticky notes reads what Editors wrote, and rule 5 says a
  Viewer only watches. Taken: D4.2.
- **E-F4** (major). Strings from disk and from Slack or Discord went on the wire uncleaned and could make
  `sticky.list` fail for everyone. Taken: D2.2 (no excerpt; a link target that is no valid name is dropped), D1.5
  (invalid names counted, a file that is not UTF-8 listed `unreadable`), D6.3 (texts through `agentText`, Slack's
  entities decoded first, names cleaned).
- **E-F5** (major). Slugs collide for good, because a deleted topic's folder stays. Taken: D5.2 (the daemon picks a
  free slug, `-2`, `-3` up to a bound, then `slug-unavailable`).
- **E-F6** (major). The notes session ends when its starter leaves and is audited as a free session. Taken: D3.5 (it
  passes to the host, like a topic's sessions).
- **E-F7** (major). Direct mode had no answer, and failures after the topic exists left orphan topics. Taken in
  part: direct mode is the Start dialog's (D5.3); the topic limit, the slug and the PLAN.md are checked before the
  topic is made, the build is recorded as soon as the topic exists, and the error names the step (D5.2, D5.4). The
  main folder's state is not checked, because nothing starts. Not taken: a second "Build this" of the same note
  makes a new topic (D5.2's free slug), and the note lists its builds (D2.4); the record keeps no failed step.
- **E-F8** (major). D8 left out what the gate needs for new documents (set aside, `DOCUMENT_SINCE`, the pin) and the
  new file `connectors.json`. Taken: D4.5 (one document, `canSetAside` false, `DOCUMENT_SINCE` not published; no
  assistant id to lose, D3.5), D6.2 (`connectors.json` in `STATE_ENTRIES`, in the persisted kinds and in
  ARCHITECTURE §7.1), D8.3. One document instead of two (D2.1, D4.5).
- **E-F9** (major). Case-only twins on Linux make links open files that do not exist. Taken: D1.3 (the folded name
  maps to the name on disk; of twins the first by code unit is the note, the other `shadowed`), D2.5 (the fold check
  against a fresh listing).
- **E-F10** (major). The hash of a CRLF or BOM note never matches, and the source of the dialog's text was not said.
  Taken: D5.1 (texts decoded as `doc.open` decodes them, the hash over the UTF-8 of that text, the text and the hash
  both from `sticky.spec`).
- **E-F11** (major). Protocol 7 left the control socket's Welcome unchanged, so a 0.7.0 command attaches to a 0.8.0
  daemon. Taken: D8.2 (the Welcome gains the required key `protocol`).
- **E-F12** (major). The first read of a new channel imports its history. Taken: D6.3 (the first read only sets the
  cursor; cursors per source and channel; a missing one starts from now).
- **E-F13** (minor). The send call, its origin and a double accept. Taken: D4.6 (`ConversationService.send` as the
  member, origin `composer`, `accepted` only after the send, a second accept refused, `no-assistant` when missing or
  ended). The label is the fixed `feedback`, with the author in the sentence (SAFE-09).
- **E-F14** (minor). The watcher alone misses notes, and "create, refused when it exists" did not map onto the file
  service. Taken in part: D2.2 (a full listing when the folder appears or disappears and after a watcher error; a
  `notes` symlink counts as no folder), D2.5 (one serialization, the folder made, the fold check, the atomic create,
  the payload `{ name }`). Not taken: no `# <name>` is written; the note starts empty (D2.5), so no second write can
  be refused by an agent's lock and the title is not drawn twice (W14).
- **E-F15** (minor). D3 did not list the places that branch on the purpose. Taken: D3.1 (no topic, no reach rules),
  D3.2 (the confined places, the mode skips), D3.5 (serialized start, audit, the session limit, retention, no id
  stored).
- **E-F16** (minor). The name's bound had no constant or unit, U+2028 breaks the PLAN.md heading, the two finders
  cannot be one parser, and the new prefixes must join the closed list. Taken in part: D1.2 (`NOTE_NAME_MAX_CHARS`
  in UTF-16 units after NFC, U+2028 and U+2029 refused, `topicNameSchema` and the heading rule), D1.4 (one finder,
  the web on plain runs, a disagreement about code pinned by a test). One prefix, `sticky`, not two (D2.1); SPEC.md
  is not edited (D4.1).
- **E-F17** (minor). `sticky.json`'s feedback at its maxima is about 12 MB, and many Viewers lock everyone out.
  Taken: D4.5 (`FEEDBACK_STORED_MAX_CHARS`, 300 waiting from members).

## R-WEB: the web and what a person sees

- **W1** (major). The renderer and the daemon cannot share one parser, because marked splits a `[[...]]` that holds
  Markdown. Taken: D1.4 (where they agree, said precisely, and a test that names the difference), D1.2 (the Markdown
  characters refused in names), "What the owner should decide" 10 (no label form).
- **W2** (major). The route needs strict encoding and decoding, and several places decide the mode over two values.
  Taken in part: D7.1 (the route, `encodeURIComponent`, decoding inside a `try`, `noteNameSchema`, the "not written
  yet" page, the four places restated over three modes), D7.2 (no layout toggles). Not in the design: the address
  replaced with the name on disk, and the top-bar link to the last open note. The router test, ACCEPTANCE T7.1,
  ARCHITECTURE §9 and the README belong to `BUILD-PLAN.md`.
- **W3** (major). `ui/Tree` cannot open a row that has children, so Home could not be opened. Taken in part: D7.4
  (an opt-in prop; Enter, Space and a click open and unfold; the twisty only folds; the default unchanged). Not in
  the design: the waiting count as part of the row's accessible name.
- **W4** (major). Opening a missing note asked `doc.open` for a file that is not there, and a mis-click wrote a
  file. Taken: D7.5 (only a listed note is held, keyed by its folded name; every wiki link is an `<a href>`), D7.6
  (the page of a name not written yet). The fast-switch test belongs to `BUILD-PLAN.md`.
- **W5** (major). "Add a sticky note" loses its line while Claude holds the note's lock, and the Read view shows no
  lock. Taken: D7.5 (the lock line in the Read view, offered only while writable and synced, `sticky.create` first,
  then one local transaction, the read-only case said).
- **W6** (major). The feature folder needed import lines the design did not name, and its chat would import a folder
  the shell keeps. Taken: D7.2 (`app/workspace/NotesView.tsx`, lazy), D7.3 (exactly two named import lines), D7.7
  (the chat as a `ColumnFrame`, "Ask Claude" through the composer's draft).
- **W7** (major). A path in Claude's text, and "Send to agent", take the person into code mode. Taken: D7.7 (a link
  to a note opens it in the notes view), D7.5 (the editor without "Send to agent").
- **W8** (major). The web mislabels a notes session, names it after its starter, and empties everyone's chat when
  the starter leaves. Taken: D3.5 (it passes to the host), D3.6 (its own title `session.title.notes`, its console
  label, listed among the sessions without a topic).
- **W9** (major). After a rename in code mode, waiting feedback has no page and fills the budgets. Taken: D7.6 (the
  page of a missing name shows its feedback), D7.4 (the group "Feedback on sticky notes that are gone").
- **W10** (major). The whole list on every autosave, no paging, and no store shape. Taken in part: D2.2 (no excerpt,
  size or time), D2.4 (changes only), D4.4 (the list rule), D7.3 (the store area and its selectors; for a member
  with `session.drive`, `sticky.feedback.list` and its event load with the channel, so that the waiting count on the
  mode link, D7.8, is right in every view). Not taken: `sticky.list` does not join every channel's first loads; the
  notes index loads when the notes view is first shown (D7.3, P-F13).
- **W11** (major). The hash did not say which text it covers, so a CRLF note never matches and a note being typed is
  built from text nobody saw. Taken in part: the dialog shows and hashes the text the daemon reads, decoded as
  `doc.open` decodes it (D5.1, D5.3), and a change after that is refused `note-changed` with the new text shown
  (D5.2). Not taken: the hash is not of the shared document's text, and "Build this" is not held while a note is
  locked or unsaved: what is built is what the dialog showed, and the member confirms it again at Start.
- **W12** (minor). Where the view's state is kept, and drafts of project text. Taken: D7.2 (`smurg.pane.notes-tree`
  and `smurg.pane.notes-chat`, no field in `smurg.layout`, the note in the address, the rest in memory).
- **W13** (minor). The chat's states were not specified. Taken: D7.7 (each state), D7.8 (Accept with no assistant
  offers "Start Claude").
- **W14** (minor). Several controls add nothing the brief asks for. Taken in part: no layout toggles (D7.2), no
  excerpts (D2.2), a link always leads to the note's page (D7.5, D7.6), waiting first and settled folded, counts and
  Accept / Reject only for `session.drive` (D7.8), no "Send to agent" (D7.5), the note starts empty (D2.5), a
  sentence for those who cannot write the first note (D7.6). Not taken: "Add a sticky note" stays, in the safe order
  (D7.5): it is how a note grows the tree from where the person is.
- **W15** (minor). `Home` is an English name in both languages, and the zh-TW smoke would report it. Taken: D1.1.
  The smoke's allowed list belongs to `BUILD-PLAN.md`.
- **W16** (minor). The proposed zh-TW pair mixed two pairs, "note" alone is taken, and the strings' places were not
  said. Taken in part: 採用 / 不採用 with the suggestion's English words Accept / Reject (D4.3); "sticky note" in full in
  every label. Not taken: the exact strings are not in the design; each step writes its words in both languages,
  checks them against `docs/GLOSSARY.md` and lists them in its handover (the header). The feature's strings files
  are in D7.3; the others belong to `BUILD-PLAN.md`.
- **W17** (minor). Where the wiki-link option goes, how it stays out of code, link or button, and which pins it
  touches. Taken: D7.5 (a synchronous option, off in code spans and link words, an `<a href>` with its title, a
  missing note said in words), D1.4 (the text-cost tests). The pins belong to `BUILD-PLAN.md`.

## R-DEBT: 0.7.0's release debt

- **D-1** (major). D8.1 named only the fixture, `TAG` and `NOT_PUBLISHED_YET`, while about a dozen tests and tables
  must change too. Not taken: the debt is not paid in this branch (D8.1, "What the owner should decide" 11); the
  exact list stays with the release chore of main (`docs/RELEASING.md` §4.5).
- **D-2** (major). The 0.6.0 driver cannot simply be run again: its part (b), its story of merges by hand and its
  minimum counts must be redone. Not taken: D8.1, as D-1.
- **D-3** (major). On this Linux machine the driver's no-git workspace finds `/bin/git`. Not taken: D8.1, as D-1.
- **D-4** (major). Once `TAG` is `v0.7.0`, shapes 4 without a step fails `other-version.test`. Taken: in this branch
  `TAG` stays `v0.6.0` (D8.1), against which the test holds; the rebase onto the paid debt restates
  `other-version.test.ts` over the declared steps, so that the upgrades expected from the tag are the steps above
  the tag's shapes: none for shapes 4 (D8.1).
- **D-5** (major). New documents break `fixtures.test` through `DOCUMENT_SINCE`, paid or not. Taken: D4.5 (the one
  new document, `DOCUMENT_SINCE` not published).
- **D-6** (major). Two fixtures of 0.7.0 made in two branches cannot be merged. Taken in part: D8.1 (paid once, on
  main, and this branch is rebased onto it). Not taken: it is not a commit S0 of this branch.
- **D-7** (minor). The driver's procedure cannot be followed in this tree or in a bare archive. Not taken: D8.1, as
  D-1.
- **D-8** (minor). With `TAG` `v0.7.0`, a Welcome without a new key fails `ctl-other-version`. Taken: D8.2 (the key
  `protocol`). The test's label goes with the debt (D8.1).
- **D-9** (minor). The fixture can leak the host's home and login on Linux. Not taken: D8.1, as D-1.

## R-PLAN: the gate and the build order

- **P-F1** (blocker). `sticky.list`, `sticky.changed` and `feedback.list` exceed one message at the design's limits.
  Taken: D2.2, D2.4 (the list rule, one change at a time, the worst case in the fixture), D4.4 (the list rule). The
  size-rule pin and ARCHITECTURE §4.3 belong to `BUILD-PLAN.md`.
- **P-F2** (major). The registry test allows 17 prefixes, and neither new one is among them. Taken in part: one
  prefix, `sticky` (D2.1; feedback is `sticky.feedback.*`, D4.4), not two. The test's set and ARCHITECTURE §5 belong
  to `BUILD-PLAN.md`.
- **P-F3** (major). With `TAG` at `v0.7.0`, `other-version.test` expects a step for every raise of the shapes.
  Taken, as D-4: the test is restated over the declared steps (D8.1). With no S0 in this branch, that comes with the
  rebase that moves `TAG` to `v0.7.0`, not with the step that raises the shapes: against `v0.6.0` the test holds.
- **P-F4** (major). `DOCUMENT_SINCE` and `canSetAside` for the new documents. Taken: D4.5 (one document,
  `canSetAside` false, `DOCUMENT_SINCE` not published). HOSTING §9.3's line for `sticky.json` belongs to
  `BUILD-PLAN.md`.
- **P-F5** (major). SPEC.md is the owner's text and is never edited. Taken: D4.1 (its own test in `roles.test.ts`,
  ARCHITECTURE §3 and D-31 in §11, SPEC.md not edited).
- **P-F6** (major). "Build this" skipped the Start dialog and failed on a second build or a taken slug. Taken: D5.2
  (a free slug, it starts nothing), D5.3 (the existing Start dialog).
- **P-F7** (major). Every audit action needs a console label in both languages. Taken: D4.8.
- **P-F8** (major). `smurg uninstall` does not know `connectors.json`. Taken: D6.2 (`STATE_ENTRIES`, the persisted
  kinds, ARCHITECTURE §7.1).
- **P-F9** (major). The host guide has about 4 KB left under its page bound, and the design adds to it. Taken: D6.2
  (the host's words go into a new last section of HOSTING, §11 in both languages, nothing renumbered; the step that
  writes it measures the built page and raises the page bound of the site's test by what the text adds, with the
  reason beside it). The members' words in JOINING belong to `BUILD-PLAN.md`.
- **P-F10** (major). G13 needs the note names before the index step. Taken: D1.1, D1.2 and D3.3 (one pure predicate
  of `packages/protocol` that the gate calls). The order belongs to `BUILD-PLAN.md`.
- **P-F11** (minor). The web's branches on the purpose and the session's name. Taken: D3.6.
- **P-F12** (minor). The feature-imports lines were not named. Taken in part: exactly two lines (D7.3). The chat is
  mounted by `NotesView` (D7.2, D7.7) and "Build this" opens the sessions view (D5.3), so the feature imports
  neither the columns nor the topics.
- **P-F13** (minor). Loading the area with every channel changes two shared tests. Taken: D7.3 (the notes index
  loads when the notes view is first shown; for a member with `session.drive`, `sticky.feedback.list` and its event
  load with the channel, so that the waiting count on the mode link is right in every view). The two shared tests
  change for that part only, which belongs to `BUILD-PLAN.md`. See W10.
- **P-F14** (minor). 不採用 would stand for two English words. Taken: D4.3 (Accept / Reject, the suggestion's words).
- **P-F15** (minor). The watcher misses a folder made in one burst, and `sticky.create` waited for it. Taken: D2.2
  (a full listing), D2.5 (the index updated at once).
- **P-F16** (minor). A removed member's waiting feedback, and feedback on a missing note. Taken: D4.5 (withdrawn,
  audited by the system), D4.4 (`not-found`).
- **P-F17** (minor). Neither the wire diff nor the catalog texts are in the design. Taken: the header (each step
  writes its words in both languages, checks them against `docs/GLOSSARY.md` and lists them in its handover).
