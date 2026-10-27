# How it works: a team and coding agents in one workspace

With smurg, you (the host) share a project folder from your own computer; teammates join in a browser, and
everyone watches the same agents work, live. Everyone reads every conversation; you and members with agent access
message agents, Editors suggest, and the team votes on agents' questions. This page in
[繁體中文](zh-TW/HOW-IT-WORKS.md).

## Three parts

- **Your computer** runs `smurg host`. The files and the agents stay there; the agents run as you
  ([what that means](#what-it-is-today)).
- **The relay** forwards the data between you and teammates and cannot read it: everything is end-to-end
  encrypted. It knows which account connects, from which IP address, and when
  ([what the relay can see](HOSTING.md#21-the-shared-relay-default)).
- **A browser** is all a teammate needs: they open the invite link in Chrome and log in with Google.

## Several people, one agent

What each [role](JOINING.md#2-roles-what-you-can-do) can say to an agent:

- **You and members with agent access** message any agent, start work, accept suggestions, and allow or deny what
  agents ask to run.
- **Editors** suggest: their message reaches the agent only once accepted. They also edit files and review
  results.
- **Viewers** watch.

Agents are told to bring decisions to the team as multiple-choice questions. Everyone but Viewers votes, and one
person submits the answer: the votes are advice ([questions and votes](JOINING.md#53-questions-and-votes)).

## From discussion to merged work

A topic is one feature or task ([every step](JOINING.md#6-topics-from-discussion-to-reviewed-result)):

1. **Discuss.** The team discusses the topic with one agent, which writes a spec.
2. **Plan.** The agent turns the spec into a plan of work items; Editors can edit both.
3. **Work.** Each work item gets its own agent, in its own git worktree (smurg's own history when the folder has
   none). In auto mode, the default, it edits files there and runs commands without asking: simple file commands at
   once, the others when Claude Code's check allows them
   ([what it asks first](HOSTING.md#52-what-agents-do-by-themselves-and-what-they-ask-first)).
4. **Merge.** Each item ends with a result report: what was done, how it was verified, every diff. smurg merges
   it into your folder, without anyone reading the diff first, when its report says it is complete and verified;
   anything else waits for a person ([merging](HOSTING.md#103-merging-and-what-waits-for-it)).
5. **Check.** When every item is merged, left out or undone, everyone is told that the topic is ready to check: the
   reports, each item's change, what the agents say they verified. You (the host) can undo an item, or turn
   automatic merging off.

## What it is today

- **The agents are Claude Code.** They run on your computer (macOS or Linux) as you, with no sandbox, on your
  Claude account, even when they work for a teammate. A worktree is a place to work, not protection. Give Agent
  access only to people you fully trust ([Before you share](HOSTING.md#4-before-you-share)).
- **A prototype.** This flow was verified against a scripted stand-in for the model, not with a real Claude
  account: how a real model behaves in it is not verified yet
  ([what was verified](HOSTING.md#108-what-was-verified-and-what-was-not)).

## Where to go next

- [Quick start](QUICKSTART.md): your first topic.
- [Host guide](HOSTING.md): if you share the folder.
- [Guide for teammates](JOINING.md): if you join a workspace.
- [Security model](SECURITY-MODEL.md): what encryption does not protect.
