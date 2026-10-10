#!/usr/bin/env bash
# The whole smurg system on this machine in one command: relay (dev login), web dev server and `smurg host` on a
# sample folder; Ctrl-C stops all of them. Details and options: scripts/dev-stack.ts
# (docs/DEVELOPMENT.md, "Local development").
#   scripts/dev-stack.sh [--dir DIR] [--relay-port 8787] [--web-port 5173] [--host-user host] [--role editor]
#                        [--stand-in-claude | --real-claude]
# --stand-in-claude: agent sessions run the scripted stand-in for Claude Code (no account, nothing is billed). Without
# it they would run the Claude Code of this machine with your own login: the script says so before it starts, and
# when nobody is at a terminal it asks for --stand-in-claude or --real-claude instead of choosing.
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=/dev/null # env.sh is linted on its own; its top-level `return` would read as an exit here
. scripts/env.sh || exit 1
exec node scripts/dev-stack.ts "$@"
