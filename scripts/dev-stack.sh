#!/usr/bin/env bash
# The whole smurg system on this machine in one command: relay (dev login), web dev server and `smurg host` on a
# sample folder; Ctrl-C stops all of them. Details and options: scripts/dev-stack.ts (README, "Local development").
#   scripts/dev-stack.sh [--dir DIR] [--relay-port 8787] [--web-port 5173] [--host-user host] [--role editor]
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=/dev/null # env.sh is linted on its own; its top-level `return` would read as an exit here
. scripts/env.sh || exit 1
exec node scripts/dev-stack.ts "$@"
