# 0.6.0: the owner's decisions (2026-10-20) and the lead's frame for the DESIGN step

Read BRIEF.md first (what the users asked, the rules), then the five understanding reports: U1/NOTES.md … U5/NOTES.md
(and their experiments). This file is what is DECIDED; the design turns it into code, state, protocol, tests, docs.
Branch: `v0.6.0-work` (from main 2faa34e). Version 0.6.0, protocol 5.

## The owner's decisions (do not re-ask them)
1. **Permissions.** Claude Code's `auto` permission mode is the DEFAULT for agent sessions. The HOST alone may switch a
   workspace to "asks for nothing" (Claude Code's `bypassPermissions`), behind a warning that says plainly what it
   means (every command runs as the host with no sandbox and no check, whoever's message or file led to it). The
   existing "asks" behaviour (today's cards) stays available as a choice.
2. **Existing 0.5.2 workspaces switch to auto at the update.** This departs from the "closed side" upgrade rule of
   ARCHITECTURE §0 (the one 0.5.1 applied to agentMcp): record it there as the owner's decision, and tell the host at
   the update (`smurg host`'s one-line notice and the console), with how to go back to asking.
3. **No git.** When the shared folder has no `.git`, smurg keeps its OWN hidden git history under `<share>/.smurg`
   (never a `.git` in the user's folder), and topics work as today: worktrees per work item, the report's diff, merge
   and reject, conflicts named before the folder is touched. When the git PROGRAM is missing (or too old, or cannot
   run), work items run DIRECTLY in the shared folder: no diff, no review before the change lands, no undo; the Start
   dialog and the guides say so plainly. (U3 measured the hidden-repository mechanics with git 2.49.)
4. **Models.** The host and every member with Agent access may choose any model Claude Code offers for the session
   (its `initialize` answer lists them), Fable included; no host allowlist. A session's model is set when it starts
   and can be changed while it runs (`set_model`); null means "the host's Claude Code default", which is what every
   0.5.2 session is.

## The lead's frame (decided here; the design may refine with reasons)
- **Agent-neutral shapes.** Protocol and stored fields say `model` (an opaque string from the agent's own list) and
  `permissionMode` with smurg's own values, not Claude Code's names; the Claude Code mapping lives in the daemon's
  Claude profile. The owner means to support other agents.
- **Auto everywhere by default**, main workspace included, as the owner asked ("nobody wants to keep pressing
  confirm"). U2 measured that auto inherits acceptEdits' shortcut (shell writes inside the working folder run without
  the classifier: `>> CLAUDE.md`, `rm`). In a worktree the merge review covers it; in the main workspace nothing does.
  The design must say what smurg adds there (U2's "G11": a gate row that still asks before a shell write in the main
  workspace to files only the host may change or that someone has open; or something better), or argue that it is
  not needed, and in any case the docs say what auto does not check.
- **Detect what really runs.** Claude Code silently falls back (auto → default with Haiku or `disableAutoMode`;
  bypass refused as root): read the mode and model Claude reports at init and after each change, show the real ones
  on the session strip, and tell the host when they differ from what was asked.
- **Honest costs.** Auto mode makes classifier calls on the host's account; Fable bills usage credits in headless mode
  on some plans "without asking". One line each where the choice is made and in the host guide.
- **Direct mode (no git program) is never silent**: the Start dialog names it before anything runs; the item's report
  says there is no diff; the plan says nothing waits for a merge.
- **Claude Code version.** The verified version stays 2.1.288 (the installed one; no download of a newer binary),
  and the design names what to re-check when a newer one is verified (U4 lists the 2.1.293/2.1.299/2.1.302 changes).
- **Upgrade discipline.** A 0.5.2 host's ~/.smurg and workspace state are read by 0.6.0 (a stored-shape step), and
  the release gate runs the published 0.4.0, 0.5.0, 0.5.1 and 0.5.2 executables against it (SMURG_PREVIOUS_BINARIES).
  The 0.5.1/0.5.2 fixture debt U5 found is paid before any shape changes.
- **Docs and site.** Every sentence that says smurg asks before commands, that topics need a git repository with a
  commit, or that the model is the host's default changes in both languages (U5's list), and the tests that hold them
  change on purpose. The home page gets no new line (the owner's rule); the third card's words and the picture's
  Build scene change only as far as the truth requires.
- **Release order.** U5's option (b): tag and let the workflow build first, then deploy the relay and publish at once
  (0.5.x hosts are cut off from browsers only for the upload), with RELEASING §4 step 3 changed in this release.

## The lead's answers to DESIGN.md §5 (2026-10-20, before the build)
1. G12 stays. 2. Direct mode is the host's (only the host starts or retries direct items). 3. The direct hold covers
every turn. 4. `GATE_ASKS_WHEN_UNSURE = false` unless test R4 shows the fast path takes such commands; then flip it and
say so in the HANDOVER. 5. The size bound and default excludes as designed. 6. D8a's places as designed. 7. "Asks for
nothing" is workspace-wide only. 8. A person's stricter mode is kept at the update (it was an explicit choice; the
owner's decision 2 is about the default). 9. The picture's Build scene changes as designed (a test run instead of a
permission card), shown to the owner before the site goes live. 10. DESIGN.md and DECISIONS.md go into
`docs/design/v0.6.0/` (S8), like v0.5.0's.

## The lead's rules for the BUILD (they replace "the lead commits" for this build only)
- Each step ends with ONE local commit on `v0.6.0-work`: `git add` of the paths it changed (never `git add -A` or `.`),
  `git -c user.name=gclinian -c user.email=<the author's address> commit -m "<subject in the repository's style>"`, no
  attribution lines. Never push, tag, reset, rebase, stash, checkout or amend; never touch another branch.
- The published executables for S8's gate come from https://downloads.smurg.ai/v<version>/ (the project's own
  domain; checked against that version's SHA256SUMS) into W/build/bin/. Earlier copies may already be in
  ../v051/GATE/pub-0.4.0, ../v051/GATE/pub-0.5.0, ../v051/POST/pub-0.5.1 (check their sums too). Nothing else from
  the network.
