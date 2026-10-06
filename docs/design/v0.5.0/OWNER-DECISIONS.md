# Owner decisions on DESIGN.md's open questions (2026-10-05). Binding; they override DESIGN.md where they differ.
The owner saw the mockups and said: build in this direction; details follow the design's defaults.
- Q6 = B: proceed with structured mode; the host guide and the New topic dialog say a personal Pro/Max subscription is
  for the host's own use and recommend an API key or Team/Enterprise for groups; one notice to the host when a
  personal subscription login is used with other members present. No blocking.
- Q7 = B (NOT the design's default): the host's own Claude Code allow rules APPLY to smurg's agent sessions; smurg does
  not ask for what the host's rules already allow. Tell the host once which of their own rules apply (information,
  no extra click). The discussion agent's own limits (the tool gate) stay enforced by smurg regardless.
- Q8 = A: no terminal-style agent fallback.
- Real-account testing: NONE by the team. Everything is verified against the fake API; the owner tries the real model
  after the release. Never use the owner's Claude account.
- Q14: Traditional Chinese for Inbox is 收件夾 (the owner's own word), not 收件匣. The other proposed words stand.
- Every other question (Q1-Q5, Q9-Q13, Q15-Q21): the design's stated default.
- Standing: one release (v0.5.0), English-first with zh-TW second, MIT, no legacy/compatibility code.
