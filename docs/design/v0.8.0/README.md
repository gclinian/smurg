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
