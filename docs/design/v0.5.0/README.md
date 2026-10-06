# The design of smurg v0.5.0, as it was written

This folder keeps the documents v0.5.0 was built from, unchanged, so that the reasons behind the code can be read
next to it. They are a record, not the contract: where they differ, `docs/ARCHITECTURE.md` (the binding document) and
the code are right.

- `OWNER-BRIEF.md`: the owner's flow and twelve decisions.
- `DESIGN.md`: the design (sections 1 to 9, appendices A to E).
- `OWNER-DECISIONS.md`: the owner's answers to the design's open questions. They override `DESIGN.md` where they
  differ (the host's own Claude Code allow rules apply to agent sessions; the zh-TW word for Inbox).
- `UX.md`: the interface design. `DESIGN.md` section 5.12 wins where it changes a screen.
- `mock/`: the static mock of the interface (open `mock/index.html`). Its screenshots are not kept here.

The documents quote zh-TW wording on purpose (the wire texts and the interface words they decide), so the repository's
"no CJK outside zh-TW files" lint exempts this folder.
