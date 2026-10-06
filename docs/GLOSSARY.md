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
| An agent or shell running on the host | session ("agent session", "terminal session") | session / 終端機 | |
| The AI | agent | agent | |
| Per-member git checkout | worktree | worktree | |
| Request to merge a worktree | merge request | 合併請求 | |
| Proposed text sent to an agent session, waiting for a member with agent access | suggestion | 建議 | |
| Link that admits someone | invite link | 邀請連結 | |
| The forwarding server | relay | relay | |
| File held by one editor/agent | lock / locked | 鎖定 | |
| Feed of changes | activity | 動態 | |
| Host-only record | audit log | 操作紀錄 | |
| Login on another screen | device login / device code | 裝置登入 / 代碼 | |
| CLI + daemon program | `smurg` (lower case, also at sentence start) | smurg | |

## Terms of the topics flow (0.5.0)

The words of the sessions view, topics, the inbox and the cards. Where a label is a web catalog key the catalog is
the source; this table is what the documents and the site use, and what a new message is checked against.

| Concept | English (UI label / prose) | zh-TW | Wire id |
|---|---|---|---|
| A feature or task with its discussion, spec, plan and sessions | **Topic** / a topic | 主題 | `topic` |
| Phases of a topic | Discussing, Spec, Plan, Executing, Complete | 討論中、spec、計畫、執行中、已完成 | |
| The main screen | **Sessions** (mode switch) / "the sessions view" in documents | session | |
| The workbench behind the switch | **Code mode** | 手寫 code 模式 | |
| Things that wait for me | **Inbox** | 收件夾 | `inbox` |
| Its two groups | Agents are waiting / For you to look at | agent 在等你 / 等你看的 | |
| The two inbox counts | "2 waiting", "4 to look at" | 2 個在等、4 個待看 | |
| The agent's multiple-choice question | question ("Question from Claude") | 選擇題（「Claude 的選擇題」） | `question` |
| Voting | vote, "Your vote", Leading, "The vote is tied", Other | 投票、你的投票、領先、票數相同、其他 | |
| An open vote in a voter's inbox | "Vote: …" | 投票：… | `vote` |
| Deciding a question | Submit answer / Answer to submit | 送出答案 / 要送出的答案 | |
| The member who decides a question | "Ian decides" (no noun in the UI; "decider" in documents only) | 由 Ian 決定 | |
| The decider's words for the agent | Note for Claude (optional) / Add to the note | 給 Claude 的備註（選填） / 加到備註 | |
| Remarks under a card | comment | 留言 | |
| Under the comment box | "Comments are for the team. Claude does not read them." | 留言是給團隊看的，Claude 不會讀。 | |
| "@name" | mention / "Ben mentioned you" | 提及 / 「Ben 提到你」 | `mention` |
| Ask the others to vote | Remind those who have not voted | 提醒還沒投票的人 | |
| Answer for someone who is away | Submit for Ian / Review instead of Amy | 代 Ian 送出 / 代替 Amy 看 | |
| The member a session's or item's attention belongs to | **Responsible** / the responsible person / "Responsible: Ian" | 負責人 / 負責人：Ian | `responsible` |
| A session nobody is assigned to | "Responsible: nobody" | 負責人：無 | |
| The plan's heading for the assignment | Who is responsible | 誰負責 | |
| Its two modes | Assigned / No one assigned: everyone watches | 指派負責人 / 不指派：大家一起看 | `assigned` / `everyone` |
| The agent asks before it acts | permission request / "Claude asks for permission to run a command" | 權限請求 / 「Claude 請求許可執行指令」 | `permission` |
| Its answers | Allow once / Always allow this kind / Deny | 允許一次 / 一律允許這類 / 拒絕 | |
| Where "always allow" applies | in this session / in every session of this topic | 在這個 session / 在這個主題的所有 session | `session` / `topic` |
| A topic's always-allowed kinds | Allowed in this topic | 這個主題一律允許 | |
| A request only the host may allow | "Only the host can allow this" | 只有主人可以允許 | |
| What a session may do without asking | permission mode | 權限模式 | |
| The two permission modes | Asks before commands / Asks before edits and commands | 執行指令前先問 / 編輯和執行指令前都先問 | `ask-commands` / `ask-all` |
| The topic's shared session | Discussion | 討論 | |
| A new discussion session for a topic | Restart discussion | 重新開始討論 | |
| An agent session without a topic | free session (documents only); the group "No topic" | 未分主題 | |
| The requirements file | spec | spec | |
| Ask for the first draft now | Write the spec now | 現在就寫 spec | |
| The file of work items | plan | 計畫 | |
| One unit of the plan | work item / "Item 3" | 工作項目 / 項目 3 | `item` |
| Plan actions | Generate plan / Update plan / Start / Ask the agent to revise | 產生計畫 / 更新計畫 / 開始 / 請 agent 修改 | |
| Recompute the split | Suggest again | 重新建議 | |
| What the agent writes when an item is done | **Result report** | 結果報告 | `report` |
| How a work item ended | Complete / Partial / Blocked | 完成 / 部分完成 / 受阻 | `complete` / `partial` / `blocked` |
| A report that waits for its reviewer | Report to review / "Waiting for your review" | 報告待看 / 等你看 | |
| Its sections (the web app's headings; the file's own are fixed English) | What was done / Why it was done this way / How it was verified / What to watch out for / Changes / Follow-ups the agent suggests / Asked about this result | 做了什麼 / 為什麼這樣做 / 怎麼驗證的 / 要注意什麼 / 變更 / agent 建議的後續工作 / 關於這個結果的追問 | |
| A question about a result | follow-up ("Ask about this result, or tell Claude what to change") | 追問（「追問這個結果，或告訴 Claude 要改什麼」） | |
| A request to rework a result | "Changes asked by Ian" | Ian 要求修改 | |
| The reviewer's confirmation | "I've reviewed this" / Reviewed | 我已看過 / 已看過 | |
| A report's snapshot before anyone asked to merge | (no label; the report's "Changes") | 變更 | `draft` |
| A reviewed report's changes in the host's inbox | Reviewed, ready to merge | 已看過，可以合併 | |
| One of the side-by-side panes | column / "Close column" / "Open to the side" | 欄 / 關閉這一欄 / 在旁邊開啟 | |
| Keep a column from being replaced | Pin column / Unpin | 釘選這一欄 / 取消釘選 | |
| The session list's filter | All / Mine / Waiting | 全部 / 我的 / 等待中 | |
| Status of a session | Running, Waiting for an answer, Waiting for permission, Idle, Done, Failed, Ended | 執行中、等待回答、等待許可、待命、完成、失敗、已結束 | |
| An execution session that ended its turn with no report | Stopped without a report | 沒寫報告就停下了 | `stalled` |
| Work that stopped and needs someone | (inbox group "Agents are waiting"; no noun) | | `attention` |
| State of an item without a session | Not started / Waiting for another item | 尚未開始 / 等待其他項目 | |
| End a turn, end a session | Stop / End session | 停止 / 結束 session | |
| Go on after an interruption | Continue / Continue all | 繼續 / 全部繼續 | |
| Start a failed thing again | Try again / Start again | 再試一次 / 重新開始 | |
| Tool actions | Read, Edited, Created, Ran, Searched | 讀取、編輯、建立、執行、搜尋 | |
| What smurg itself told the agent | "smurg asked Claude to …" (a line of the conversation) / "smurg told Claude" (the message itself) | smurg 請 Claude… / smurg 告訴 Claude | `smurg` |
| The host's confirmation of project settings | "Claude Code project settings" / Use them / Run without them (agents will not read CLAUDE.md) | Claude Code 專案設定 / 使用 / 不載入（agent 不會讀 CLAUDE.md） | |
| The host's own Claude Code allow rules | "Your own Claude Code rules apply here" (they apply to agent sessions; the host is told once which) | 你自己的 Claude Code 規則在這裡也適用 | `host-rules` |
| Put a finished topic away | Archive topic | 封存主題 | |

Not part of 0.5.0, so no word for them: who has a session on screen ("Watching now"), comments on a section of the
spec, a permission mode that asks for nothing, a button that makes oneself responsible (the responsible person is
changed in the session's menu), and a choice between asking anyway and keeping the host's own rules (the host's own
Claude Code allow rules always apply to agent sessions).

Where a zh-TW word of the design differs from the catalog that was built, the catalog is the source and this table
follows it (`tests/lint/docs-quotes.test.ts` holds the guides to the catalogs).

The four role labels are the messages `role.host`, `role.agent`, `role.editor`, `role.viewer` of
`@smurg/protocol/i18n` (`roleLabel(locale, role)`); no other file spells them out for display.

## Language-neutral names

Names that are stored and shown to everyone have ONE spelling and are never translated.

| Name | Form |
|---|---|
| Agent display name | `Claude (Checkout)` (a topic's discussion: the topic's name), `Claude (Cart API)` (a work item: its title), `Claude (Ian)` (a session without a topic: who opened it) |
| Browser device name | `Chrome (macOS)`, fallback `Browser` |
| CLI device name | `smurg CLI (<hostname>)`, fallback `smurg CLI` |
| Relay fallback user name | `Google user` |
| Language names in the switch | `English`, `繁體中文` (each always in its own language) |

Text written by a person or an agent (a message, a suggestion, a comment, a vote's own answer, a note for the agent,
a merge message, a reject reason, a topic's name, a work item's title, a session title someone typed, the spec, the
plan, a result report's sections, an agent's notification, display names, file names) is never translated. The headings
of a result report file and the field names of a plan file are fixed English; the web app shows its own headings.

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
rule). PTY bytes, everything smurg tells an agent (role prompts, the header above a person's message, hook deny
reasons, MCP tool texts), git commit messages, logs and audit codes are fixed English.
