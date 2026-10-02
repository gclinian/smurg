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

## Rules

Read `docs/ARCHITECTURE.md` §0 before you write or run code. In short:

1. Only ever signal a process your own code started and recorded; never by name or pattern.
2. No real credentials, anywhere: tests use the mock API and the relay's dev login.
3. No browser cookie import, no logged-in browser sessions.
4. Nothing global: no global installs, no edits outside the checkout; tests remove what they create.
5. Never block the daemon's event loop.
6. Fail closed: hooks, path checks and permission checks deny when anything is uncertain.

`docs/ARCHITECTURE.md` §1 has the layout and which package may import which.

## Language

- English is the default language of everything: code, comments, tests, commit messages, docs. Traditional Chinese
  (zh-TW) is the second language of the product.
- Every text a person sees comes from a message catalog and exists in both languages; a message is written in English
  first. No user-visible string literal outside the catalogs.
- Use the terms and the style of [`docs/GLOSSARY.md`](docs/GLOSSARY.md) (role names, "host", "member", "session", …).
- The user guides exist in both languages with the same section numbers (`docs/HOSTING.md`, `docs/JOINING.md`,
  `docs/zh-TW/`); change both. The changelog too: an entry goes into `CHANGELOG.md` and `docs/zh-TW/CHANGELOG.md`.
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
