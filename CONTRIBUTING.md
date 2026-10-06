# Contributing to smurg

Thank you for helping. Bugs and ideas: open an issue. Security problems: see [SECURITY.md](SECURITY.md), never a
public issue.

## Setup

macOS or Linux, Node.js 22 (`.nvmrc`). Nothing is installed globally.

```sh
scripts/bootstrap-tools.sh        # the repository's own pnpm, into .tools/
source scripts/env.sh             # in every shell: Node 22, the repository's pnpm, tool state kept inside the checkout
pnpm install
pnpm check                        # the gate: type check of every package, then every test
```

`pnpm check` must be green before a pull request. One package only: `pnpm --filter @smurg/daemon test`
(more ways to run: `docs/ACCEPTANCE.md`). After a dependency change run `node scripts/third-party-notices.ts` and
commit both notices files.

You do not need Claude Code or a Claude account to develop or to run the gate. Agent sessions in the tests are
driven by a stand-in for the `claude` command that follows a scripted scenario
(`packages/daemon/src/testing/fake-claude.mjs`). The tests that start the real `claude` binary are skipped when it is
not installed in a verified version, and when it is, they run it only against the repository's fake Anthropic API,
with a dummy key and an isolated configuration folder.

## Rules

Read `docs/ARCHITECTURE.md` §0 before you write or run code. In short:

1. Only ever signal a process your own code started and recorded; never by name or pattern.
2. No real credentials, anywhere: tests use the fake Anthropic API and the relay's dev login. Never run a test, an
   experiment or a demo against a real Claude account.
3. No browser cookie import, no logged-in browser sessions.
4. Nothing global: no global installs, no edits outside the checkout; tests remove what they create.
5. Never block the daemon's event loop.
6. Fail closed: hooks, path checks and permission checks deny when anything is uncertain.
7. What smurg promises about an agent's limits is enforced by smurg's own code (the tool gate that runs before every
   tool call), never only by Claude Code's permission flow.

`docs/ARCHITECTURE.md` §1 has the layout and which package may import which. The design of the topics flow, as it
was written before the code, is in `docs/design/v0.5.0/`; where it and `docs/ARCHITECTURE.md` differ, the
architecture document describes what was built.

Three things to keep in mind when you touch agents:

- Nothing a member without agent access writes may reach an agent unseen. Text for an agent goes through the one
  cleaning and framing function of `@smurg/protocol` (`agentText`, `frameMessage`); do not build such text anywhere
  else.
- The wire carries only smurg's own shapes, never Claude Code's: the daemon normalises what Claude Code prints, and
  the web app refuses what it does not know.
- A change to what agents are told (the role prompts), or to the plan and report formats, cannot be verified with
  the stand-in alone. Say in the pull request what you could not check with a real model.

## Language

- English is the default language of everything: code, comments, tests, commit messages, docs. Traditional Chinese
  (zh-TW) is the second language of the product.
- Every text a person sees comes from a message catalog and exists in both languages; a message is written in English
  first. No user-visible string literal outside the catalogs.
- Use the terms and the style of [`docs/GLOSSARY.md`](docs/GLOSSARY.md) (role names, "host", "member", "session", …).
- The user guides exist in both languages with the same section numbers (`docs/HOSTING.md`, `docs/JOINING.md`,
  `docs/zh-TW/`); change both. The changelog too: an entry goes into `CHANGELOG.md` and `docs/zh-TW/CHANGELOG.md`.
  The `smurg` command's help links sections of the guides by their heading (`#4-before-you-share`, for example): do
  not rename or renumber a section without changing the catalogs.
- In the guides, quotation marks are for text smurg shows, exactly as its catalogs render it ("..." in English,
  the corner brackets in zh-TW), on one line; anything else is written without them. A sample that contains a number
  or a name goes in `code`. When you change a label, change the guides and the product page's picture of the app
  (`apps/site/public/`) in the same pull request.
- Everything smurg tells an agent (role prompts, the header above a person's message, hook and tool texts), the
  headings of a result report file and the field names of a plan file are fixed English and are not in a catalog.
- The gate enforces these rules (`tests/lint/`): no Chinese text outside the zh-TW catalogs and documents, the
  catalogs and the documents of the two languages in step, the guides quoting what the catalogs render, and every
  test naming the language it runs in (`SMURG_LANG=en` for a CLI it starts, `locale` for a browser context). It says
  "log in", never "sign in".

## Pull requests

- Keep a change to one thing, with the tests that prove it. A bug fix starts with a test that fails without it.
- No compatibility code for old versions unless an issue says it is needed.
- Workflow runs of first-time contributors wait for a maintainer's approval.

## License

smurg is MIT-licensed ([LICENSE](LICENSE)). By contributing you agree that your contribution is licensed under the
same terms.
