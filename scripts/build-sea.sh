#!/usr/bin/env bash
# Packages the `smurg` command (CLI + daemon, with node-pty and the other native parts) as one executable for this
# platform (Node SEA), checks that it runs, then smoke-tests it. Details, options and what a build machine needs:
# scripts/build-sea.ts.
#   scripts/build-sea.sh [--node /path/to/node] [--out FILE] [--version X.Y.Z|vX.Y.Z] [--target PLATFORM-ARCH]
#                        [--no-smoke] [--keep-work]
# Output: packages/cli/dist/smurg-<platform>-<arch> (darwin-arm64, darwin-x64, linux-x64, linux-arm64).
cd "$(dirname "$0")/.." || exit 1
# shellcheck source=/dev/null # env.sh is linted on its own; its top-level `return` would read as an exit here
. scripts/env.sh || exit 1
exec node scripts/build-sea.ts "$@"
