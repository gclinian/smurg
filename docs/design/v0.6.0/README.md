# The design of smurg v0.6.0, as it was written

This folder keeps the documents v0.6.0 was built from, so that the reasons behind the code can be read next to it.
They are a record, not the contract: where they differ, `docs/ARCHITECTURE.md` (the binding document) and the code
are right.

- `DECISIONS.md`: the owner's four decisions of 2026-10-20 (auto mode by default and "Asks for nothing" for the host
  alone; existing workspaces switch to auto at the update; smurg's own history without `.git`, and work items run
  directly in the shared folder without the git program; any model the host's Claude Code offers), the lead's frame
  for the design, the lead's answers to the design's open questions (`DESIGN.md` §5) and the lead's rules for the
  build. The answers override `DESIGN.md` where they differ. One line differs from what was written: the build's
  commit command gives the author's address as a placeholder.
- `DESIGN.md`: the design (D1 to D22, the security review, the risks, what was left for the lead or the owner, and
  the appendices: the wire diff of protocol 5, every catalog text in both languages, the evidence), revised after
  two reviews (security and honesty, engineering and upgrade), unchanged here. Where the build took a side the
  design left open, `docs/ARCHITECTURE.md` says what was built (for example `GATE_ASKS_WHEN_UNSURE`, which the real
  Claude Code 2.1.288 set to true, §7.7).

Not kept here: the five understanding reports, the two reviews and their experiments, and the build plan with each
step's notes. The documents above name them (`U1` to `U5`, `R-SEC`, `R-ENG`, `D/ANSWERS.md`) as the evidence they
quote; `DESIGN.md` Appendix C says what each claim rests on.

The documents quote zh-TW wording on purpose (the wire texts and the interface words they decide), so the repository's
"no CJK outside zh-TW files" lint exempts this folder.
