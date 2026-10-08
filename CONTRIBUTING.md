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

To try the app by hand, start the local stack with `scripts/dev-stack.sh --stand-in-claude` (README, "Local
development"): its agent sessions then run the same scripted stand-in. Without that switch a `claude` on your `PATH`
would run the stack's agent sessions with your own login; the script says so before it starts anything, and refuses
when it is not run from a terminal.

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
8. What a published smurg wrote, every later smurg reads: no reset, no default, no lenient parse, and an upgrade
   step is never removed (below: "When you change something smurg stores").

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

And one when you touch anything that reads text a member or an agent wrote (a message, a name, a path, a spec, a
plan, a report, a shell command, the output of a tool): what it costs must be in proportion to the text. Each
package has a test that walks such functions with hostile texts at two sizes and keeps a list, per source file, of
its regular expressions, sorts and normalisations (`test/text-cost.test.ts` in `packages/protocol`,
`packages/daemon` and `packages/cli`; `apps/web/test/text-cost.test.tsx`). A new one fails that test until the
list follows: look at what it costs on a long run of one character first. A text whose length someone else chose
is normalised only through `normalized` of `packages/protocol/src/normalize.ts`.

### When you change something smurg stores

People have workspaces that 0.4.0, 0.5.0 and every later version wrote, and the next version must open all of them
(`docs/ARCHITECTURE.md` §0 rule 8 and §7.1, "What a published smurg wrote is read by every later one"). smurg 0.5.0
broke this without anyone changing a stored file's own schema: three settings were added to a schema of the
protocol package that `state.json` imports. So the rule is about what a stored file ACCEPTS, wherever that is
written:

- **What counts.** Every document a module declares (`declareDocument`), and everything else under a workspace's
  folder: the lines of the audit log and of the activity feed, a session's `cards.json` and transcript, an upload's
  manifest and journal, the stamp, the name of a kept copy. A stored shape changes when a key is added, removed or
  renamed, when an optional key becomes required, when a union gains or loses a branch, and also when a RULE gets
  tighter with no change of shape (a shorter limit, a stricter path check in `packages/protocol`).
- **The test that stops you** is the pin, `packages/daemon/test/upgrade/pin.test.ts`. What it sees, exactly (the
  head of the test says the same, list by list):
  - by hash, the source of every file of the daemon that defines a stored schema (`DAEMON_SOURCES`: each file that
    declares a document, and those of the stored things that are no document) and of every module of
    `packages/protocol` that ANY run-time name those files import leads to (`PROTOCOL_SOURCES`; the walk stops only
    where `WALK_STOPS` says why, and a name it cannot follow fails the test). A rule written as code (a `.refine`,
    a path check) is in no description of a schema: only the source says it;
  - one by one, each with its reason, the other files of the daemon that a schema file imports
    (`DAEMON_FILES_NO_STORED_VALUE_PASSES`): a new import fails until that file is pinned or reasoned;
  - as text, the shape of every stored schema and of the stamp (`packages/daemon/test/upgrade/shapes/`);
  - byte for byte, the frozen shapes (`FROZEN`); line by line, the formats that are no schema (`FORMAT_LINES`).

  It fails when one of these changes, and asks one question: does this change what a stored file accepts? It does
  not know the answer: a comment in a pinned file fails it as surely as a tightened rule. And it does not see a
  rule in a file of the daemon that is no schema file, a value a schema reads at run time from outside the pinned
  files, or what an upgrade of zod does with the same description. For the last, the files the published versions
  wrote must still open (the fixtures, below).
- **If it does not** (a comment, a new export nothing stored uses, a rule for something that is never stored): take
  the pins again in the same change, and say in the pull request why the answer is no. `SMURG_PIN_WRITE=1 pnpm
  --filter @smurg/daemon exec vitest run test/upgrade/pin.test.ts` writes the shape texts only; a hash is edited in
  the test, in the list its failure names.
- **If it does**, the change comes with all of this:
  1. a frozen copy of the shape the last published version wrote, in `packages/daemon/src/frozen/v<that
     version>.ts`: literal, with its own scalar rules, importing zod and nothing else. A frozen file is never edited
     again;
  2. a step on the document (`defineStep({ from: '<that version>', shape, upgrade, sinceShapes })`). A step carries
     every record, drops nothing without saying so, and gives a new security-relevant value its closed side as a
     constant of the step (never today's default, which may change);
  3. `WORKSPACE_SHAPES` raised by one (`packages/daemon/src/core/state-store.ts`), also for a file that is not a
     document. An older smurg then refuses the folder as written by a newer one and tells the host to update; it
     never tries to read it;
  4. the new point named in `NOT_PUBLISHED_YET` (`packages/daemon/test/upgrade/fixtures.test.ts`) until a published
     version's fixture holds it, and the pins taken again.
- **Never**: a default in a stored schema, `.strip()` or `.passthrough()`, a "repair" that drops what does not
  parse, a reset. Each of them was shown to let a removed member, a revoked device or a stranger with a used-up link
  back in. A file that cannot be read is refused untouched, with a kind the command can word
  (`StateFileError`).
- **What you cannot change in a minor version**: the `version` of `~/.smurg/workspaces.json` and `credentials.json`
  (the published versions erase a file whose version they do not know: add optional fields, or a new file), and what
  the daemon sends on its control socket or on the wire (the published commands and pages read both strictly). A new
  host setting is both a wire change and a stored-shape change (`docs/ARCHITECTURE.md` §7.1, "What 0.5.1 could not
  repair").
- **In the browser** the same holds for what a page stores (the device key and the recorded host keys in IndexedDB,
  the panel settings in `localStorage`): a newer record is never replaced by an older page, and a key that is
  renamed is carried once (`apps/web/src/app/workspace/layout.ts`, `packages/protocol/src/browser/key-stores.ts`).

The fixtures of the published versions (`packages/daemon/test/fixtures/published/`) are never edited by hand; a
release adds the one of its version (`docs/RELEASING.md` §4.5).

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
