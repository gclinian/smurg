#!/usr/bin/env bash
# Installs the repo-local pnpm into .tools/ (nothing global: no corepack, no `npm i -g`, npm cache kept in .tools).
# The version comes from the root package.json "packageManager" field so there is exactly one source of truth.
# Usage: scripts/bootstrap-tools.sh        (idempotent; re-installs only when the version differs)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck disable=SC2034 # read by scripts/env.sh, sourced next
SMURG_ENV_SKIP_PNPM_CHECK=1
# shellcheck source=/dev/null # env.sh is linted on its own; its top-level `return` would read as an exit here
source "$ROOT/scripts/env.sh" || exit 1
unset SMURG_ENV_SKIP_PNPM_CHECK
set -euo pipefail

wanted="$(node -p 'const pm = require(process.argv[1]).packageManager ?? ""; const m = /^pnpm@(\d+\.\d+\.\d+)$/.exec(pm); if (!m) throw new Error("root package.json packageManager must be pnpm@X.Y.Z, got " + JSON.stringify(pm)); m[1]' "$ROOT/package.json")"
pnpm_bin="$ROOT/.tools/node_modules/.bin/pnpm"

if [ -x "$pnpm_bin" ] && [ "$("$pnpm_bin" --version 2>/dev/null || true)" = "$wanted" ]; then
  echo "pnpm $wanted already installed in .tools/"
  exit 0
fi

mkdir -p "$ROOT/.tools"
npm_config_cache="$ROOT/.tools/npm-cache" \
  npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false \
  npm install --prefix "$ROOT/.tools" --no-save --no-package-lock "pnpm@$wanted"
echo "installed pnpm $("$pnpm_bin" --version) into .tools/"
