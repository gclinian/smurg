# smurg v0.8.0: the owner's brief (2026-11-11)

## The owner's words (the original is zh-TW)

> 我現在想要改使用介面和合作模式，我認為目前使用介面太複雜了，我想要試試看一個介面：一開始大家就在一個類似筆記軟體的介面寫便利貼，
> 右邊是 AI 聊天窗，可以用 AI 聊天窗在便利貼上編輯，每張便利貼是用 wiki link 連到另一張便利貼，起始只有一張便利貼，之後就能樹狀的
> 去延伸更多便利貼，這樣大家就能輕鬆的在某張小便利貼上編輯協作
>
> 然後我還想加個功能，讓所有人都可以透過留言的方式，來便利貼提出意見，開發者可以去審核和同意這些意見，然後語言模型自動把意見變成
> 新的便利貼或 prompt，讓 agent 把功能做出來。這種留言希望也可以支援從 slack 或是 discord 訊息來收集

## The same, translated

"I want to change the interface and the way of collaborating. I think the current interface is too complex. I want to
try this one: from the start, everyone writes sticky notes in an interface like a note-taking app; on the right is an
AI chat window, and the AI chat window can edit the sticky notes. Each sticky note links to another sticky note with a
wiki link. At the start there is only one sticky note; from it more sticky notes can be extended like a tree, so that
everyone can easily edit and collaborate on one small sticky note.

I also want a feature that lets everyone give their opinion on a sticky note by leaving a comment. Developers can
review and approve these opinions; then the language model automatically turns the opinions into new sticky notes or
into a prompt, and an agent builds the feature. I want these comments to be collectable from Slack or Discord
messages too."

## How the brief was given

One message to the lead, with two instructions about the work itself: do it in a git worktree, so that other features
can be developed in parallel; the lead's subagents run on Claude Opus 5.5. The owner was not asked anything before the
design was written: every side the design takes without the owner's word is listed in `DESIGN.md`, "What the owner
should decide", with what the other side would cost.
