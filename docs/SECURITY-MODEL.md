# Security model: what the relay sees, what teammates can do

Is it safe to share a folder and coding agents with teammates through a server? That server (the relay) forwards
encrypted data it cannot read, but knows who connects, from where and when. Encryption does not protect you from
the people you invite: every member can read the folder and every conversation, and a teammate with agent access
acts as you on your computer, with no sandbox. smurg is a prototype, with no outside audit. This page in
[繁體中文](zh-TW/SECURITY-MODEL.md).

## Where things live

On your computer: the files, the agents and terminals, and in `~/.smurg` the conversations and the workspace's
key.

## What is encrypted

Everything a workspace exchanges (files, conversations, terminal output) is end-to-end encrypted between your
computer and each teammate's browser or CLI.

An invite link ends in `#k=…&s=…`: the fingerprint of the workspace's key, which the teammate's browser checks,
and the secret that lets them join. The relay never sees the secret. Whoever has the link can join until it expires
or is revoked: send it privately ([Share](HOSTING.md#3-share)).

## What the relay knows

- **It sees** each connection's Google account and IP address, its workspace, and the size and time of every
  message.
- **It stores** each workspace's ID and its host's account; for at most 10 minutes, `smurg login` requests and
  counters against code guessing.
- On the shared relay, smurg's maintainer and Cloudflare can know this
  ([details](HOSTING.md#21-the-shared-relay-default)). Or
  [run your own](HOSTING.md#22-other-relays---relay).

## What encryption does not protect

- **The web app comes from the relay.** A relay that served a tampered app could read what the browser decrypts,
  and its keys.
- **Every member can see and download the files** (`.env` too), reads every conversation and watches every
  terminal: Viewers too, and members who join later. Do not share a folder that holds secrets
  ([host guide §4](HOSTING.md#4-before-you-share)).
- **No agent is sandboxed.** The agents are Claude Code today, on your Claude account. A personal subscription is
  for your own use, [not a group's](HOSTING.md#4-before-you-share). Agents run in Claude Code's auto mode unless you
  choose to be asked: Claude Code decides which commands run (simple file commands in the agent's own folder at once,
  the others after its check), and smurg itself still asks before a few
  ([§5.2](HOSTING.md#52-what-agents-do-by-themselves-and-what-they-ask-first)); your own allow rules apply
  ([§5.3](HOSTING.md#53-your-own-claude-code-allow-rules-mcp-servers-project-settings-claudemd)); what is
  allowed runs as you, and a teammate's file can hide instructions for the agent. A work item's change reaches your
  folder without you reading it first, unless you turn automatic merging off; an Editor's hand edit in a work item
  still waits for you.
- **Agent access is your account.** A teammate with this role can run any command on your computer, read your home
  folder and use your Claude account; smurg cannot limit this. Give the role only to people you fully trust
  ([§5.1](HOSTING.md#51-the-agent-access-role-read-this-first)); make everyone else an Editor
  ([roles](JOINING.md#2-roles-what-you-can-do)).

## What was checked

smurg was [verified](HOSTING.md#108-what-was-verified-and-what-was-not) with a scripted stand-in for the model,
not a real Claude account. The encryption (the Noise protocol) is smurg's own implementation, with no outside
audit. Trust model and known limits:
[`docs/ARCHITECTURE.md`](ARCHITECTURE.md#2-trust-model-in-one-page), §2 and
[§12](ARCHITECTURE.md#12-known-limits-of-the-prototype).

Report a vulnerability privately, never in a public issue: [`SECURITY.md`](../SECURITY.md).
