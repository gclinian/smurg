# smurg glossary (English / zh-TW)

Binding for every text smurg shows: the web app, the CLI, the relay's pages, the installer, the docs and the site.
A message is written in English first; the zh-TW text is then checked against it. Role labels and every text the
daemon originates live in the wire catalog (`packages/protocol/src/i18n/`), so the web app and the CLI use one wording.

## Terms

| Concept | English (UI label / prose) | zh-TW | Wire id |
|---|---|---|---|
| The person sharing | **Host** / the host | 主人 | `host` |
| Role: may edit and use agents | **Agent access** / "members with agent access", "can use agents" | 可使用 agent | `agent` |
| Role: may edit | **Editor** | 可編輯 | `editor` |
| Role: read only | **Viewer** | 旁觀 | `viewer` |
| Anyone in a workspace (UI) | member | 成員 | |
| Non-host people (docs, site) | teammate | 組員 | |
| Shared folder + its people | workspace | 工作區 | |
| An agent or shell running on the host | session ("Claude session", "terminal session") | session / 終端機 | |
| The AI | agent | agent | |
| Per-member git checkout | worktree | worktree | |
| Request to merge a worktree | merge request | 合併請求 | |
| Proposed text sent to a session's driver | suggestion | 建議 | |
| Link that admits someone | invite link | 邀請連結 | |
| The forwarding server | relay | relay | |
| File held by one editor/agent | lock / locked | 鎖定 | |
| Feed of changes | activity | 動態 | |
| Host-only record | audit log | 稽核紀錄 | |
| Login on another screen | device login / device code | 裝置登入 / 代碼 | |
| CLI + daemon program | `smurg` (lower case, also at sentence start) | smurg | |

The four role labels are the messages `role.host`, `role.agent`, `role.editor`, `role.viewer` of
`@smurg/protocol/i18n` (`roleLabel(locale, role)`); no other file spells them out for display.

## Language-neutral names

Names that are stored and shown to everyone have ONE spelling and are never translated.

| Name | Form |
|---|---|
| Agent display name | `Claude (Ian)` |
| Browser device name | `Chrome (macOS)`, fallback `Browser` |
| CLI device name | `smurg CLI (<hostname>)`, fallback `smurg CLI` |
| Relay fallback user name | `Google user` |
| Language names in the switch | `English`, `繁體中文` (each always in its own language) |

Text written by a person or an agent (a suggestion, a merge message, a reject reason, a session title someone typed,
an agent's notification, display names, file names) is never translated.

## Style

English:

- Sentence case for every UI label and heading: "New session", not "New Session".
- Natural, short, second person ("You do not have permission to do this.").
- Errors say what happened and what to do. No "please", no exclamation marks.
- A label is not a sentence and has no full stop ("Agent access"); a sentence has one.
- `smurg` is lower case, also at the start of a sentence.
- CLI and installer output is ASCII only (`...`, `->`), so it is safe under `LANG=C`.
- Counts use real plural forms ("1 file", "2 files"), never "file(s)".

zh-TW:

- The existing wording stays as it is, except where a sentence has become false.
- Traditional Chinese with full-width punctuation; loanwords stay in Latin letters (agent, session, worktree, relay,
  smurg) with a space between Latin and Chinese text.
- No plural forms.

Both:

- One message per distinct sentence. Never build a sentence from translated fragments; pass names, paths and counts
  as parameters and let each language order them.
- Lists are joined per language (`, ` in English, `、` in zh-TW).
- Do not quote a button's label in running text when the label lives in another program's catalog (say "approve the
  request in your browser").

## Locales

Exactly two: `en` (the default and the source of truth for keys) and `zh-TW`. The language is the viewer's: each
process picks a language only for text it shows to its own user (`@smurg/protocol/locale` holds the one detection
rule). PTY bytes, hook deny reasons, MCP tool texts, git commit messages, logs and audit codes are fixed English.
