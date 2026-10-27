# The design of smurg v0.7.0, as it was written

This folder keeps the documents v0.7.0 is built from, so that the reasons behind the code can be read next to it.
They are a record, not the contract: where they differ, `docs/ARCHITECTURE.md` (the binding document) and the code
are right.

- `DESIGN.md`: the design (D1 to D23: 0.6.0's release debt paid first, protocol 6, the host's setting "Merging work
  items" with work items that merge by themselves when they are in order, the merge queue, decisions, the end of a
  topic ("Ready to check"), undo, plans that go on after a restart, the words, the docs and the tests; the security
  review, the risks, what was left for the lead, and the appendices: the wire diff of protocol 6, every catalog text
  in both languages, the evidence), revised after two reviews (security and honesty, engineering and upgrade), and
  unchanged since. Where the build took a side the design left open, or found a sentence of it that could not be
  built as written, `docs/ARCHITECTURE.md` and the code say what was built (for example the audit entry of the
  update's step is `settings.change`, ARCHITECTURE §7.1, where D4 names a message type).
- `ANSWERS.md`: the lead's answers to the design's open questions (`DESIGN.md` §5, 2026-10-27, before the build): every
  side the design took was taken. The answers override `DESIGN.md` where they differ. One line differs from what was
  written: the build's commit command gives the author's address as a placeholder.
- `BUILD-PLAN.md`: how the design is cut into ten build steps (S0 to S9), each with the files it owns, what it does,
  its gate and its commit.

Copied here by step S0, before anything else changed (DESIGN D1, D23: the build's scratch folder loses files nobody
read for about four days); step S9 added the lead's answers and found the design and the plan unchanged.

Not kept here: the four understanding reports, the two reviews and their experiments, and each step's notes. The
documents above name them (`U1` to `U4`, `R-SAFE`, `R-ENG`, `D/ANSWERS.md`) as the evidence they quote;
`DESIGN.md` Appendix C says what each claim rests on.

The documents quote zh-TW wording on purpose (the wire texts and the interface words they decide), so the repository's
"no CJK outside zh-TW files" lint exempts this folder.
